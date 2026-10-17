// Convex's runtime has no `queueMicrotask`, and a Worker-style handler may call it: TanStack's
// router does on every rendered page. `index.ts` imports this module first, so the definition runs
// when this package loads, which `convex/http.ts` imports before the app's server entry. A native
// implementation is left intact.
if (typeof globalThis.queueMicrotask !== "function") {
  globalThis.queueMicrotask = (callback) => {
    void Promise.resolve().then(callback);
  };
}
