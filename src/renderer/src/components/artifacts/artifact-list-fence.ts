import type { ArtifactListItem } from '../../../../shared/artifacts'

/**
 * Rows changed on this desktop after a list request started win over that response: a Refresh
 * begun before a Mark done must not bring back the page as it was.
 */
export function keepRowsMutatedAfterRequest(
  incoming: readonly ArtifactListItem[],
  local: readonly ArtifactListItem[],
  mutatedAfterRequest: (slug: string) => boolean
): ArtifactListItem[] {
  const localBySlug = new Map(local.map((item) => [item.artifact.slug, item]))
  return incoming.map((item) => {
    const kept = mutatedAfterRequest(item.artifact.slug)
      ? localBySlug.get(item.artifact.slug)
      : undefined
    return kept ?? item
  })
}
