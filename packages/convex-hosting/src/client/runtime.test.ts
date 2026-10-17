import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

// Convex's runtime has no queueMicrotask, so a test deletes the test runtime's own before the
// package entry is evaluated. The tests import the entry, as apps do: `runtime.ts` is a script,
// which a dynamic import cannot type. Besides it, the entry loads only `convex/server`, which never
// reads the global.
const queueMicrotaskDescriptor = Object.getOwnPropertyDescriptor(globalThis, "queueMicrotask");

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (queueMicrotaskDescriptor) {
    Object.defineProperty(globalThis, "queueMicrotask", queueMicrotaskDescriptor);
  }
});

test("defines queueMicrotask when the runtime has none", async () => {
  Reflect.deleteProperty(globalThis, "queueMicrotask");
  expect("queueMicrotask" in globalThis).toBe(false);
  await import("./index.js");

  const order: string[] = [];
  const ran = new Promise<void>((resolve) => {
    queueMicrotask(() => {
      order.push("callback");
      resolve();
    });
  });
  order.push("sync");
  await ran;
  expect(order).toEqual(["sync", "callback"]);
});

test("leaves the runtime's queueMicrotask in place", async () => {
  await import("./index.js");
  expect(Object.getOwnPropertyDescriptor(globalThis, "queueMicrotask")).toEqual(
    queueMicrotaskDescriptor,
  );
});
