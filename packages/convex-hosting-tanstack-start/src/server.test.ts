import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
// The test runtime resolves React's Node server build, which reads queueMicrotask when it loads;
// the Convex build uses `react-dom/server.edge`, which checks for it first. The entry's
// dependencies therefore load here, before a test deletes the global.
import "@tanstack/react-start/server";

// Convex's runtime has neither global, so the tests delete the test runtime's own before the entry
// is evaluated.
const queueMicrotaskDescriptor = Object.getOwnPropertyDescriptor(globalThis, "queueMicrotask");
const sizeDescriptor = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, "size");

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (queueMicrotaskDescriptor) {
    Object.defineProperty(globalThis, "queueMicrotask", queueMicrotaskDescriptor);
  }
  if (sizeDescriptor) Object.defineProperty(URLSearchParams.prototype, "size", sizeDescriptor);
});

test("defines queueMicrotask when the runtime has none", async () => {
  Reflect.deleteProperty(globalThis, "queueMicrotask");
  expect("queueMicrotask" in globalThis).toBe(false);
  await import("./server.js");

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
  await import("./server.js");
  expect(Object.getOwnPropertyDescriptor(globalThis, "queueMicrotask")).toEqual(
    queueMicrotaskDescriptor,
  );
});

test("defines URLSearchParams size when the runtime has none", async () => {
  Reflect.deleteProperty(URLSearchParams.prototype, "size");
  expect(new URLSearchParams("a=1&a=2").size).toBeUndefined();
  await import("./server.js");
  expect(new URLSearchParams("a=1&a=2").size).toBe(2);
});

test("leaves the runtime's URLSearchParams size in place", async () => {
  await import("./server.js");
  expect(Object.getOwnPropertyDescriptor(URLSearchParams.prototype, "size")).toEqual(
    sizeDescriptor,
  );
});
