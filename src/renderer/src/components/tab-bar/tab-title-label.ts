// Why: seven "Advertising run NNN" tabs all truncate to "Adve…" under plain end
// truncation, so the run number — the only thing that tells them apart — is the
// first thing to go. When enough siblings share a long prefix, keep a stub of the
// prefix and give the tail the width instead ("Adv…255"). Pure so the rule is
// unit-testable without a strip.

const ELLIPSIS = '…'

/** At least this many strip tabs must share the prefix before it is collapsed. */
export const SHARED_PREFIX_MIN_TABS = 3
/** A shorter shared prefix is not worth hiding — end truncation still shows enough. */
export const SHARED_PREFIX_MIN_CHARS = 8
/** How much of the collapsed prefix survives so the label still reads as its family. */
export const SHARED_PREFIX_HEAD_CHARS = 3
/**
 * A title this short ("Terminal 3") fits a tab at all but the most squeezed widths, so
 * end truncation still shows its tail — collapsing it to "Ter…3" would only lose text.
 */
export const SHARED_PREFIX_MIN_TITLE_CHARS = 12

// Why: split on code points, not UTF-16 units, so a surrogate pair (emoji) never
// gets cut in half by either the prefix walk or the truncation slice.
function codePoints(value: string): string[] {
  return Array.from(value)
}

function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[i] === b[i]) {
    i += 1
  }
  return i
}

/**
 * Length (in code points) of the prefix `title` shares with at least
 * `SHARED_PREFIX_MIN_TABS - 1` other titles, or 0 when no such prefix of
 * `SHARED_PREFIX_MIN_CHARS` or more exists. Computed per title (not across the
 * whole strip) so a mixed strip — five "Advertising run …" tabs next to two
 * "Terminal" tabs — still collapses the advertising family. The prefix is backed
 * off to the last whitespace so "Advertising run 16" (from 161/165/169) does not
 * leave one-digit tails.
 */
export function sharedTitlePrefixLength(titles: readonly string[], title: string): number {
  const own = codePoints(title)
  const overlaps: number[] = []
  let seenSelf = false
  for (const other of titles) {
    // Why: the title's own strip entry is not a sibling; skip exactly one occurrence.
    if (!seenSelf && other === title) {
      seenSelf = true
      continue
    }
    const overlap = commonPrefixLength(own, codePoints(other))
    if (overlap >= SHARED_PREFIX_MIN_CHARS) {
      overlaps.push(overlap)
    }
  }
  const needed = SHARED_PREFIX_MIN_TABS - 1
  if (overlaps.length < needed) {
    return 0
  }
  overlaps.sort((a, b) => b - a)
  let prefixLength = overlaps[needed - 1]
  // Why: a prefix ending mid-token strands a partial tail; retreat to the last
  // whitespace boundary when that still leaves a prefix worth collapsing.
  let boundary = prefixLength
  while (boundary > 0 && !/\s/.test(own[boundary - 1])) {
    boundary -= 1
  }
  if (boundary >= SHARED_PREFIX_MIN_CHARS) {
    prefixLength = boundary
  }
  return prefixLength >= SHARED_PREFIX_MIN_CHARS ? prefixLength : 0
}

function endTruncate(points: readonly string[], maxChars: number): string {
  if (points.length <= maxChars) {
    return points.join('')
  }
  return `${points
    .slice(0, Math.max(0, maxChars - 1))
    .join('')
    .trimEnd()}${ELLIPSIS}`
}

/**
 * How a strip label gives up width. `family` (the default) collapses a shared prefix
 * so a numbered family keeps its tail; `end` always keeps the start.
 */
export type TabTitleTruncation = 'family' | 'end'

/**
 * The label a strip tab shows for `title` given every visible sibling title.
 * Shared-prefix families truncate from the middle ("Adv…255"); everything else
 * keeps end truncation. `maxChars` is the character budget for the whole label;
 * the full title still belongs in `title=`/the tooltip.
 * Why `end` exists: a workflow tab is named by its preset or its question ("Build + Review",
 * "Fix the off-by-one in…"), which reads from its start — three drafts must not become
 * "Bui…Review".
 */
export function tabTitleLabel(
  titles: readonly string[],
  title: string,
  maxChars: number,
  truncation: TabTitleTruncation = 'family'
): string {
  const points = codePoints(title)
  const prefixLength =
    truncation === 'family' && points.length > SHARED_PREFIX_MIN_TITLE_CHARS
      ? sharedTitlePrefixLength(titles, title)
      : 0
  if (prefixLength === 0) {
    return endTruncate(points, maxChars)
  }
  const tail = points.slice(prefixLength).join('').trimStart()
  if (tail.length === 0) {
    // Why: a title that IS the shared prefix has no distinguishing tail to save.
    return endTruncate(points, maxChars)
  }
  const head = points.slice(0, SHARED_PREFIX_HEAD_CHARS).join('').trimEnd()
  const tailBudget = Math.max(1, maxChars - codePoints(head).length - 1)
  return `${head}${ELLIPSIS}${endTruncate(codePoints(tail), tailBudget)}`
}
