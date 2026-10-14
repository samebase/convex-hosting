// Convex Auth cookie sessions for pages that `convex/http.ts` renders with
// `server.fetch(request, { context: { token } })`, the access token of the session cookie.

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import type { ConvexQueryClient } from "@convex-dev/react-query";
import { redirect, useNavigate } from "@tanstack/react-router";
import { useConvexAuth, type ConvexReactClient } from "convex/react";
import { useEffect, type ReactNode } from "react";

/** The request context of a page render: the session's access token, or `null` without one. */
export interface RequestContext {
  token: string | null;
}

// Start's `Register`, through `@tanstack/react-router`, which this file imports: TypeScript 7 does
// not load a module that only an augmentation names.
declare module "@tanstack/react-router" {
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
    <ConvexAuthNextjsProvider client={client} initialToken={token}>
      <ReleaseWhenSignedOut client={client} />
      {children}
    </ConvexAuthNextjsProvider>
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
 * A gate's `beforeLoad`: a server render without a session redirects to `to`. Only the server
 * render has the cookie; a browser navigation has no `serverContext`.
 */
export function redirectWithoutSession(serverContext: RequestContext | undefined, to: string) {
  if (serverContext?.token === null) throw redirect({ to });
}

/** A gate's component: navigates to `to` when the session ends, in this tab or in another one. */
export function RedirectWithoutSession({ to, children }: { to: string; children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!isLoading && !isAuthenticated) void navigate({ to });
  }, [isLoading, isAuthenticated, navigate, to]);
  return children;
}
