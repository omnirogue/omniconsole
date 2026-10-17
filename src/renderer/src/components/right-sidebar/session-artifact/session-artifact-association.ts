import type { ArtifactSessionRecord } from '../../../../../shared/artifact-session'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'

/** The conversation on the main screen, in the identity the IDE's terminals carry. */
export type ArtifactSessionTarget = {
  worktreeId: string
  /** The terminal tab id, or the unified tab id for a structured agent session. */
  tabId: string
  /** Set only for a split terminal tab: the focused pane. */
  leafId: string | null
}

export function artifactSessionTargetKey(target: ArtifactSessionTarget): string {
  return JSON.stringify([target.worktreeId, target.tabId, target.leafId])
}

/**
 * Whether an artifact belongs to the session on screen: only when that session's pane published
 * it. Why nothing weaker: conversations share one folder (a whole brand's Marketing folder), so a
 * workspace or "file inside the folder" match showed one page in every conversation there.
 * Records without a publishing pane (older ones, or a publish from outside the IDE) show nowhere.
 */
export function artifactBelongsToSession(
  record: Pick<ArtifactSessionRecord, 'origin'>,
  target: ArtifactSessionTarget
): boolean {
  const paneKey = record.origin?.paneKey ? parsePaneKey(record.origin.paneKey) : null
  if (!paneKey) {
    return false
  }
  return (
    paneKey.tabId === target.tabId && (target.leafId === null || paneKey.leafId === target.leafId)
  )
}

/** The session's artifacts, most recently published first. */
export function artifactsForSession(
  records: readonly ArtifactSessionRecord[],
  target: ArtifactSessionTarget | null
): ArtifactSessionRecord[] {
  if (!target) {
    return []
  }
  return records
    .filter((record) => artifactBelongsToSession(record, target))
    .sort((left, right) => (right.savedAt ?? -1) - (left.savedAt ?? -1))
}
