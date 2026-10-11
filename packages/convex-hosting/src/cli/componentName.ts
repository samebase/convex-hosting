/**
 * Component instance name resolution shared by the deploy and upload commands.
 *
 * `@convex-dev/static-hosting` mounted the component as `staticHosting`; this
 * package defaults to `hosting`. An app that switches packages but keeps
 * its existing instance (`app.use(hosting, { name: "staticHosting" })`)
 * keeps its uploaded files and URLs. Without the probe it would have to pass
 * `--component staticHosting` on every command. Instead the CLI probes both
 * names when the caller relied on the default, and warns when it lands on the
 * legacy one.
 */
export const DEFAULT_COMPONENT_NAME = "hosting";
export const LEGACY_COMPONENT_NAME = "staticHosting";

/**
 * Instance names to probe, in order, for a requested name.
 *
 * Only the default request expands to include the legacy name. Any other
 * requested name is used verbatim: an explicit custom name must never be
 * silently redirected to a different instance.
 */
export function componentNameCandidates(requested: string): string[] {
  if (requested !== DEFAULT_COMPONENT_NAME) return [requested];
  return [DEFAULT_COMPONENT_NAME, LEGACY_COMPONENT_NAME];
}

/**
 * Whether resolving `requested` to `resolved` was a legacy-name auto-detection
 * worth warning about. Only true when the caller relied on the default and we
 * fell back to the legacy name — an explicitly requested name (including a
 * command forwarding the resolved name to a subprocess) is left silent so a
 * single `deploy` warns at most once.
 */
export function isLegacyAutoDetected(requested: string, resolved: string): boolean {
  return requested === DEFAULT_COMPONENT_NAME && resolved === LEGACY_COMPONENT_NAME;
}

/** Warning shown once when a command resolves to the legacy instance name. */
export function legacyComponentNameWarning(name: string): string {
  return (
    `⚠️  Using the component instance "${name}" (the @convex-dev/static-hosting ` +
    `default; this package's default is "${DEFAULT_COMPONENT_NAME}").\n` +
    `   It keeps working without flags. To use the default, rename the instance ` +
    `to "${DEFAULT_COMPONENT_NAME}" and upload your files again.`
  );
}
