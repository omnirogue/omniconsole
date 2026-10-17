import { artifactLifecycleSnapshot, type ArtifactReviewStatus } from './artifact-review'
import {
  DISCOVER_OMNIOS_MAX_FINDINGS,
  DISCOVER_OMNIOS_PICKS,
  discoverOmniosKey,
  type DiscoverOmniosPick,
  type DiscoverOmniosRun
} from './discover-omnios-page'

/** Read the saved answer, never the possibly truncated prose delivered to the session. */
export function discoverOmniosPicks(
  run: DiscoverOmniosRun,
  status: ArtifactReviewStatus,
  page: number
) {
  const decision = status.latest
  const lifecycle = artifactLifecycleSnapshot(status)
  if (
    status.status !== 'approved' ||
    decision?.decision !== 'approved' ||
    lifecycle.revision !== decision.revision ||
    lifecycle.lifecycle ||
    lifecycle.supersededBy
  ) {
    throw new Error('A current approved decision is required')
  }
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error('Invalid page')
  }
  const findings = run.findings.slice(
    (page - 1) * DISCOVER_OMNIOS_MAX_FINDINGS,
    page * DISCOVER_OMNIOS_MAX_FINDINGS
  )
  if (!findings.length) {
    throw new Error('Page has no findings')
  }
  if (
    decision.edits !== null &&
    decision.edits !== undefined &&
    (typeof decision.edits !== 'object' || Array.isArray(decision.edits))
  ) {
    throw new Error('Invalid decision edits')
  }
  const edits = decision.edits as Record<string, unknown> | null
  const picks = new Map<number, DiscoverOmniosPick>()
  const set = (n: number, pick: unknown, key?: unknown) => {
    const finding = findings.find((f) => f.n === n)
    if (
      !finding ||
      (key !== undefined && key !== finding.key) ||
      !DISCOVER_OMNIOS_PICKS.includes(pick as DiscoverOmniosPick) ||
      picks.has(n)
    ) {
      throw new Error('Invalid or duplicate finding pick')
    }
    picks.set(n, pick as DiscoverOmniosPick)
  }
  if (edits?.selected !== undefined && !Array.isArray(edits.selected)) {
    throw new Error('Invalid selected indices')
  }
  if (edits?.picks !== undefined && !Array.isArray(edits.picks)) {
    throw new Error('Invalid structured picks')
  }
  if (Array.isArray(edits?.picks)) {
    for (const row of edits.picks) {
      if (typeof row?.key !== 'string') {
        throw new Error('Missing finding key')
      }
      set(row?.n, row?.pick, row?.key)
    }
    if (picks.size !== findings.length) {
      throw new Error('Incomplete structured picks')
    }
    for (const finding of findings) {
      const named = edits?.[discoverOmniosKey(finding)]
      if (named !== undefined && named !== picks.get(finding.n)) {
        throw new Error('Conflicting picks')
      }
    }
  } else if (Array.isArray(edits?.selected)) {
    for (const n of edits.selected) {
      if (!Number.isSafeInteger(n) || n < 1) {
        throw new Error('Invalid selected index')
      }
      set(findings[n - 1]?.n ?? -1, 'Start')
    }
    for (const finding of findings) {
      if (!picks.has(finding.n)) {
        picks.set(finding.n, 'Not now')
      }
    }
  } else {
    for (const name of Object.keys(edits ?? {})) {
      if (/^\d+\./.test(name) && !findings.some((f) => discoverOmniosKey(f) === name)) {
        throw new Error('Unknown finding')
      }
    }
    for (const finding of findings) {
      set(finding.n, edits?.[discoverOmniosKey(finding)] ?? finding.recommended)
    }
  }
  return {
    decisionId: decision.id,
    revision: decision.revision,
    page,
    picks: findings.map((f) => ({ n: f.n, key: f.key, pick: picks.get(f.n)! }))
  }
}
