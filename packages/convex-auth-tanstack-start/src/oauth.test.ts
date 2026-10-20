import { AuthClient, InMemoryStorage } from "@convex-dev/auth/browser";
import type {
  OauthActions,
  OauthFlowError,
  OauthProviderRefs,
} from "@convex-dev/auth/methods/oauth/react";
import { getFunctionName, makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { oauthKeepingHistoryState } from "./oauth.js";

// The state that TanStack Router's browser history gives the entry of the page.
const routerState = { key: "k1", __TSR_key: "k1", __TSR_index: 2 };

// What `setupGithub(...).attachUserCallbacks(...)` exports from the app's `convex/auth.ts`.
const github: OauthProviderRefs = {
  providerName: "github",
  startSignIn: makeFunctionReference<"mutation">("auth:startSignInWithGithub"),
  completeSignIn: makeFunctionReference<"mutation">("auth:completeSignInWithGithub"),
};

const session = { accessToken: "access-1", accessTokenExpiresAt: 0, userId: "user-1" };

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A page load in the browser, with the auth client that `ConvexAuthNextjsProvider` builds: cookie
 * mode, the entry's OAuth ambient sign-in, the sign-in API that posts to `/auth/signin`, the
 * deployment's client for the other mutations, and the provider's own URL cleanup for Next's router.
 */
async function loadPage(
  href: string,
  storage: InMemoryStorage,
  completeSignIn: () => Promise<unknown> = async () => ({ status: "complete", tokens: session }),
) {
  const replaceState = vi.fn();
  vi.stubGlobal("window", { location: { href }, history: { state: routerState, replaceState } });
  vi.stubGlobal("navigator", { product: "Gecko" });
  const signInRoute = vi.fn().mockImplementation(completeSignIn);
  const deployment = vi
    .fn()
    .mockResolvedValue({ redirect: "https://github.com/login/oauth/authorize", state: "state-1" });
  const nextRouterCleanup = vi.fn();
  const client = new AuthClient({
    mode: "ssr",
    authApi: { refreshSession: async () => null, signOut: async () => {} },
    storage,
    storageNamespace: "https://happy-animal-123.convex.cloud",
    ambientSignIns: {
      signIns: [oauthKeepingHistoryState()],
      signInApi: { mutation: signInRoute, action: vi.fn() },
      convex: { mutation: deployment },
      replaceUrl: nextRouterCleanup,
    },
  });
  await client.init();
  // A code goes to the sign-in route after `init` resolves; the client reports loading until then.
  await vi.waitFor(() => expect(client.getSnapshot().isLoading).toBe(false));
  // The keys that Convex Auth's `useOauthSignIn()` and `useOauth()` read.
  const values = client.ambientSignInValues("oauth");
  return {
    client,
    replaceState,
    signInRoute,
    deployment,
    nextRouterCleanup,
    actions: values.get<OauthActions>("actions"),
    flowError: () => values.get<OauthFlowError | null>("flowError"),
  };
}

/** GitHub's sign-in button on the home page: the flow returns to it. */
async function startGithubFlow(storage: InMemoryStorage) {
  const page = await loadPage("https://site.example/", storage);
  expect(await page.actions?.signIn(github)).toEqual({
    status: "redirect",
    redirect: new URL("https://github.com/login/oauth/authorize"),
  });
  // Starting mints no session, so it goes to the deployment, not to the sign-in route.
  expect(page.deployment).toHaveBeenCalledWith(github.startSignIn, {
    redirectTo: "https://site.example/",
  });
  expect(page.signInRoute).not.toHaveBeenCalled();
}

test("redeems the code through the sign-in route and cleans the URL with the router's state", async () => {
  const storage = new InMemoryStorage();
  await startGithubFlow(storage);

  const page = await loadPage("https://site.example/?convexAuthCode=code-1", storage);

  expect(page.replaceState.mock.calls).toEqual([[routerState, "", "https://site.example/"]]);
  expect(page.nextRouterCleanup).not.toHaveBeenCalled();
  expect(page.signInRoute).toHaveBeenCalledTimes(1);
  const [completeSignIn, args] = page.signInRoute.mock.calls[0] ?? [];
  expect(getFunctionName(completeSignIn)).toBe("auth:completeSignInWithGithub");
  expect(args).toEqual({ code: "code-1", state: "state-1" });
  expect(page.client.getSnapshot()).toEqual({
    isLoading: false,
    isAuthenticated: true,
    token: "access-1",
  });
  expect(page.flowError()).toBeNull();
});

const thrown = new Error("The sign-in route answered 500.");

test.each([
  { url: "/?convexAuthError=access_denied", flowError: { error: "ACCESS_DENIED" } },
  { url: "/?convexAuthError=expired", flowError: { error: "EXPIRED" } },
  {
    url: "/?convexAuthCode=code-1",
    completeSignIn: async () => ({ status: "error", userError: { error: "INVALID_CODE" } }),
    flowError: { error: "EXPIRED" },
  },
  { url: "/?convexAuthCode=code-1", started: false, flowError: { error: "INVALID_FLOW" } },
  {
    url: "/?convexAuthCode=code-1",
    completeSignIn: async () => {
      throw new ConvexError({ reason: "not invited" });
    },
    flowError: { error: "REJECTED", data: { reason: "not invited" } },
  },
  {
    url: "/?convexAuthError=oauth_error",
    flowError: { error: "OTHER_ERROR", cause: "oauth_error" },
  },
  {
    url: "/?convexAuthCode=code-1",
    completeSignIn: async () => {
      throw thrown;
    },
    flowError: { error: "OTHER_ERROR", cause: thrown },
  },
])(
  "$url reports $flowError.error after the same cleanup",
  async ({ url, started = true, completeSignIn, flowError }) => {
    const storage = new InMemoryStorage();
    if (started) await startGithubFlow(storage);

    const page = await loadPage(new URL(url, "https://site.example").href, storage, completeSignIn);

    expect(page.flowError()).toEqual(flowError);
    expect(page.replaceState.mock.calls).toEqual([[routerState, "", "https://site.example/"]]);
    expect(page.nextRouterCleanup).not.toHaveBeenCalled();
    expect(page.client.getSnapshot().isAuthenticated).toBe(false);
  },
);
