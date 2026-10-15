// Convex Auth cookie sessions for pages that `convex/http.ts` renders with
// `server.fetch(request, { context: { token } })`, the access token of the session cookie.

import { ConvexAuthNextjsProvider, useAuthActions } from "@convex-dev/auth/nextjs";
import type { ConvexQueryClient } from "@convex-dev/react-query";
import {
  redirect,
  useLocation,
  useRouter,
  type InferFrom,
  type InferMaskFrom,
  type InferMaskTo,
  type InferTo,
  type RegisteredRouter,
  type ValidateNavigateOptions,
  type ValidateRedirectOptions,
} from "@tanstack/react-router";
// TypeScript 7 refuses the `Register` augmentation below for a module this file does not import. The
// import does not survive into the emitted declaration; a Start app loads the module through its
// generated route tree, which is what makes the augmentation visible to it.
import type {} from "@tanstack/react-start";
import { useConvexAuth, type ConvexReactClient } from "convex/react";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

/** The request context of a page render: the session's access token, or `null` without one. */
export interface RequestContext {
  token: string | null;
}

// Start's own `Register`, where it reads `requestContext`. TypeScript 5.9 does not merge a
// declaration on `@tanstack/react-router`, which re-exports `Register` too, into this one.
declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: RequestContext };
  }
}

/**
 * The root route's `beforeLoad`. On the server, the render's Convex HTTP client queries with the
 * token, so loaders run as the user. The browser gets the token at hydration and none later.
 */
export function sessionBeforeLoad({
  context,
  serverContext,
}: {
  context: { convexQueryClient: ConvexQueryClient };
  serverContext?: RequestContext;
}) {
  const token = serverContext?.token;
  if (token) context.convexQueryClient.serverHttpClient?.setAuth(token);
  return { token };
}

/** The token of the server render, as the root route's context has it. */
const SessionToken = createContext<string | null | undefined>(undefined);

/**
 * Wraps the document. The app creates its Convex client with `expectAuth`, which holds the first
 * subscription until a token arrives, so a page rendered as the user gets the user's live answer.
 * Convex's provider never releases that hold for a visitor without a session, so this releases it
 * when the provider reports none. The provider reads `initialToken` once, when it mounts.
 */
export function SessionProvider({
  client,
  token,
  children,
}: {
  client: ConvexReactClient;
  token: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <SessionToken value={token}>
      <ConvexAuthNextjsProvider client={client} initialToken={token}>
        <ReleaseWhenSignedOut client={client} />
        {children}
      </ConvexAuthNextjsProvider>
    </SessionToken>
  );
}

function ReleaseWhenSignedOut({ client }: { client: ConvexReactClient }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  useEffect(() => {
    if (!isLoading && !isAuthenticated) client.setAuth(async () => null);
  }, [client, isLoading, isAuthenticated]);
  return null;
}

/**
 * Whether the visitor is signed in, or `undefined` while it is unknown.
 *
 * Convex Auth reports loading during the server render and the hydration, so the token of the
 * server render decides until the provider settles: a string means that the server rendered as the
 * user, and `null` that it found no session. The Vite dev server renders without a request context,
 * so it has no token. Both renders read the same token, so the hydration matches.
 */
export function useSignedIn(): boolean | undefined {
  const token = useContext(SessionToken);
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (!isLoading) return isAuthenticated;
  return token === undefined ? undefined : token !== null;
}

/** `Authenticated` of `convex/react`, rendered by the server render too. */
export function SignedIn({ children }: { children: ReactNode }) {
  return useSignedIn() === true ? children : null;
}

/** `Unauthenticated` of `convex/react`, rendered by the server render too. */
export function SignedOut({ children }: { children: ReactNode }) {
  return useSignedIn() === false ? children : null;
}

/**
 * A sign-out through the app's sign-out route, such as `/auth/signout`. The returned function posts
 * to the route; when it fails or cannot be reached, it returns `false` and changes nothing, because
 * the cookie and the session stay. Convex Auth's `signOut()` resolves even when the route failed, so
 * the route's answer decides. After a 2xx, `signOut()` clears the stored access token and tells the
 * other tabs (its own call to the route is then redundant), and the page reloads, because
 * `expectAuth` holds queries only before the first authentication.
 */
export function useSignOutSession(url: string): () => Promise<boolean> {
  const { signOut } = useAuthActions();
  return async () => {
    const response = await fetch(url, { method: "POST", credentials: "include" }).catch(() => null);
    if (!response?.ok) return false;
    await signOut();
    location.reload();
    return true;
  };
}

/**
 * A gate's `beforeLoad`: a server render without a session throws `redirect(options)`. Only the
 * server render has the cookie; a browser navigation has no `serverContext`.
 */
export function redirectWithoutSession<TOptions>(
  serverContext: RequestContext | undefined,
  options: ValidateRedirectOptions<RegisteredRouter, TOptions>,
) {
  if (serverContext?.token === null) {
    throw redirect<
      RegisteredRouter,
      InferTo<TOptions>,
      InferFrom<TOptions>,
      InferMaskFrom<TOptions>,
      InferMaskTo<TOptions>
    >(options);
  }
}

/**
 * A gate's component: without a session, after it ends in this tab or in another one, or on a
 * navigation inside the app to a gated page, it renders nothing and navigates to `to`, a path, or
 * the options that `to` builds from `next`, the gated page.
 */
export function RedirectWithoutSession<TOptions>({
  to,
  children,
}: {
  to: string | ((next: string) => ValidateNavigateOptions<RegisteredRouter, TOptions>);
  children: ReactNode;
}) {
  const signedIn = useSignedIn();
  const router = useRouter();
  // The location of this render, the gated page. The router's `resolvedLocation` still names the
  // page that a navigation inside the app left, until the gated page has rendered.
  const next = useLocation({ select: (location) => location.href });
  // Once the redirect starts, the location names its target while this gate stays mounted, and the
  // effect runs again: a second redirect would put the sign-in page in `next`. The latch opens
  // again when the session returns while the gate is still mounted, so a later sign-out redirects.
  const redirected = useRef(false);
  useEffect(() => {
    if (signedIn === true) {
      redirected.current = false;
      return;
    }
    if (signedIn !== false || redirected.current) return;
    redirected.current = true;
    if (typeof to === "string") {
      void router.navigate({ to, replace: true });
    } else {
      void router.navigate<
        RegisteredRouter,
        InferTo<TOptions>,
        InferFrom<TOptions>,
        InferMaskFrom<TOptions>,
        InferMaskTo<TOptions>
      >({ ...to(next), replace: true });
    }
  }, [signedIn, router, to, next]);
  return signedIn === false ? null : children;
}
