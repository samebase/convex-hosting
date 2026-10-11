/// <reference types="vite/client" />
import { test } from "vite-plus/test";
import { convexTest } from "convex-test";
import schema from "./schema.js";
import component from "@samebase/convex-hosting/test";

const modules = import.meta.glob("./**/*.*s");
// When users want to write tests that use your component, they need to
// explicitly register it with its schema and modules.
export function initConvexTest() {
  const t = convexTest(schema, modules);
  component.register(t);
  return t;
}

test("setup", () => {});
