import { z } from "zod";
import { runComponent, type Cli } from "./commands.js";
import type { Target } from "./target.js";

/**
 * Component instance name resolution shared by the deploy and upload commands.
 *
 * `@convex-dev/static-hosting` mounted the component as `staticHosting`; this package defaults to
 * `hosting`. An app that switched packages and kept its instance
 * (`app.use(hosting, { name: "staticHosting" })`) works without `--component staticHosting`: when
 * the caller gives no `--component`, the CLI probes both names and warns when it lands on the
 * legacy one.
 */
export const DEFAULT_COMPONENT_NAME = "hosting";
export const LEGACY_COMPONENT_NAME = "staticHosting";

/** Instance names to probe, in order. An explicit name is never redirected to another instance. */
export function componentNameCandidates(requested: string | null): string[] {
  return requested === null ? [DEFAULT_COMPONENT_NAME, LEGACY_COMPONENT_NAME] : [requested];
}

export function legacyComponentNameWarning(name: string): string {
  return (
    `Using the component instance "${name}" (the @convex-dev/static-hosting default; this ` +
    `package's default is "${DEFAULT_COMPONENT_NAME}"). Pass --component ${name} to skip the probe.`
  );
}

export const liveVersionResult = z.object({ versionId: z.string(), liveAt: z.number() }).nullable();

/**
 * The first candidate instance that answers `lib:getLiveVersion` on the target, or `null` when none
 * does: the backend is not pushed yet, or it runs a component without that function (0.3.x).
 */
export async function findComponent(
  cli: Cli,
  target: Target,
  requested: string | null,
): Promise<string | null> {
  for (const name of componentNameCandidates(requested)) {
    try {
      await runComponent(cli, target, name, "lib:getLiveVersion", {}, liveVersionResult);
    } catch {
      continue;
    }
    if (requested === null && name === LEGACY_COMPONENT_NAME) {
      console.warn(legacyComponentNameWarning(name));
    }
    return name;
  }
  return null;
}
