// The estate's "Merge when ready" box: a task-list line a scheduled job adds to PR bodies on
// deploy branches. A tick is Sal's or Uma's go; the job then marks the PR ready, lifts
// do-not-merge and merges once the base's required checks pass.

const BOX_LINE = /^- \[( |x|X)\] \*\*Merge when ready\*\*/m

export type MergeWhenReadyBoxState = 'ticked' | 'unticked' | 'absent'

export function readMergeWhenReadyBox(body: string | null | undefined): MergeWhenReadyBoxState {
  const match = BOX_LINE.exec(body ?? '')
  if (!match) {
    return 'absent'
  }
  return match[1] === ' ' ? 'unticked' : 'ticked'
}

/** The body with the box ticked or unticked, or null when the body has no box to change. */
export function setMergeWhenReadyBox(body: string, ticked: boolean): string | null {
  if (!BOX_LINE.test(body)) {
    return null
  }
  return body.replace(BOX_LINE, `- [${ticked ? 'x' : ' '}] **Merge when ready**`)
}

export type MergeHold = { kind: 'label'; label: string } | { kind: 'title'; phrase: string }

const HOLD_LABEL = /^do[\s_-]*not[\s_-]*merge$/i
const TITLE_HOLD = /\bdo[\s-]*not[\s-]*merge(?:[\s-]+yet)?\b/i
// The marker plus the brackets around it, e.g. "[DO NOT MERGE]" or "(do not merge yet)".
const TITLE_HOLD_MARKER = /[[(]?\s*\bdo[\s-]*not[\s-]*merge(?:[\s-]+yet)?\b\s*[\])]?/i

/** Holds a person set on purpose; "Merge all" never lifts them, one PR's button asks first. */
export function findMergeHolds(pr: { title: string; labels: readonly string[] }): MergeHold[] {
  const holds: MergeHold[] = pr.labels
    .filter((label) => HOLD_LABEL.test(label.trim()))
    .map((label) => ({ kind: 'label', label }))
  const phrase = TITLE_HOLD.exec(pr.title)
  if (phrase) {
    holds.push({ kind: 'title', phrase: phrase[0] })
  }
  return holds
}

/** The title without its "do not merge" marker, or null when nothing sensible would remain. */
export function titleWithoutMergeHold(title: string): string | null {
  if (!TITLE_HOLD.test(title)) {
    return null
  }
  const stripped = title
    .replace(TITLE_HOLD_MARKER, ' ')
    .replace(/^[\s:|–—-]+|[\s:|–—-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
  return stripped.length > 0 ? stripped : null
}
