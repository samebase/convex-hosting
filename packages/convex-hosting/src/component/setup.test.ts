/// <reference types="vite/client" />
import { test } from "vite-plus/test";
import schema from "./schema.js";
import { convexTest } from "convex-test";
export const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
  const t = convexTest(schema, modules);
  return t;
}
test("setup", () => {});
