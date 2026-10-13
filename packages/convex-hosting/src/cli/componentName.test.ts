import { describe, expect, test } from "vite-plus/test";
import {
  componentNameCandidates,
  DEFAULT_COMPONENT_NAME,
  LEGACY_COMPONENT_NAME,
} from "./componentName.js";

describe("component name resolution", () => {
  test("no --component probes the default name, then the legacy name", () => {
    expect(componentNameCandidates(null)).toEqual([DEFAULT_COMPONENT_NAME, LEGACY_COMPONENT_NAME]);
  });

  test("an explicit name is used verbatim, also when it is the default", () => {
    expect(componentNameCandidates(DEFAULT_COMPONENT_NAME)).toEqual([DEFAULT_COMPONENT_NAME]);
    expect(componentNameCandidates("hostingV2")).toEqual(["hostingV2"]);
  });
});
