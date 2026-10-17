/**
 * The version an installed build compares against the release feed.
 *
 * Lives in its own module so tests that mock the prerelease feed do not have
 * to know about it (a local-build stamp `x.y.z-local.<ts>.<sha>` is still x.y.z).
 */
/**
 * The version an update check should compare against. A local build carries
 * `local.<timestamp>.<commit>` as (part of) its prerelease, which semver ranks
 * BELOW its own base version — so a laptop running 1.5.1-local.… was offered
 * "1.5.1" as an update (Uma, 2026-09-07). A local build IS its base version
 * for this purpose: only a strictly higher release is news to it.
 */
export function effectiveCurrentVersion(version: string): string {
  const cut = version.search(/[-.]local\.\d+\.[0-9A-Za-z-]+$/)
  return cut > 0 ? version.slice(0, cut) : version
}
