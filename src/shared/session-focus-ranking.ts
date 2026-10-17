/**
 * The one ranking behind the focus view's lines (Session Focus Plan §11): one Needs you line when
 * anything asks, up to three lines for folders that matter now (four when nothing asks), and one
 * Everything else line. The sidebar's focus view and `omni session organize` dry runs both count
 * with it, so a plan's "lines after" is what the sidebar will show.
 */

/** Sal's focus budget: the default sidebar never shows more lines. */
export const SESSION_FOCUS_LINE_LIMIT = 5
/** The bucket of unfiled sessions; it can earn a line but is never counted as a folder. */
export const SESSION_FOCUS_UNFILED_BUCKET = 'unfiled'

/** What earns a folder its line; a question never does, it is already on the Needs you line. */
export type SessionFocusRank = 'working' | 'waitingSoon'

/** One session that counts toward the focus view (hidden, archived and snoozed ones do not). */
export type SessionFocusEntry = {
  /** Its line: a top-level folder, a saved folder or the unfiled bucket. */
  bucket: string
  /** Saved folders never earn a line of their own. */
  rankable: boolean
  /** Tie-break between equally urgent buckets: lower comes first. */
  order: number
  needsYou: boolean
  /** What it adds to its bucket's urgency; null for done, stopped or unknown. */
  rank: SessionFocusRank | null
}

export type SessionFocusRanking = {
  needsYou: number
  /** Buckets that earn a line, most urgent first. */
  folders: { bucket: string; rank: SessionFocusRank }[]
  /** Buckets with something happening that fold into Everything else for lack of room. */
  folded: string[]
  everythingElse: { sessions: number; folders: number }
  /** Needs you (when anything asks), the folder lines, and Everything else, always drawn. */
  lines: number
}

const RANKS: SessionFocusRank[] = ['working', 'waitingSoon']

type Bucket = {
  key: string
  rankable: boolean
  order: number
  counts: Record<SessionFocusRank, number>
}

export function rankSessionFocusEntries(
  entries: readonly SessionFocusEntry[]
): SessionFocusRanking {
  const buckets = new Map<string, Bucket>()
  for (const entry of entries) {
    let bucket = buckets.get(entry.bucket)
    if (!bucket) {
      bucket = {
        key: entry.bucket,
        rankable: entry.rankable,
        order: entry.order,
        counts: { working: 0, waitingSoon: 0 }
      }
      buckets.set(entry.bucket, bucket)
    }
    // Why: a question is counted once, on Needs you; it must not also earn its folder a line.
    if (entry.rank && !entry.needsYou) {
      bucket.counts[entry.rank] += 1
    }
  }
  const needsYou = entries.filter((entry) => entry.needsYou).length
  const happening = [...buckets.values()]
    .filter((bucket) => bucket.rankable)
    .flatMap((bucket) => {
      const rank = RANKS.find((candidate) => bucket.counts[candidate] > 0)
      return rank ? [{ bucket, rank }] : []
    })
    .sort(
      (a, b) =>
        RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank) ||
        b.bucket.counts[b.rank] - a.bucket.counts[a.rank] ||
        a.bucket.order - b.bucket.order
    )
  const room = SESSION_FOCUS_LINE_LIMIT - (needsYou > 0 ? 2 : 1)
  const lined = happening.slice(0, room)
  const shown = new Set(lined.map(({ bucket }) => bucket.key))
  const rest = entries.filter((entry) => !entry.needsYou && !shown.has(entry.bucket))
  return {
    needsYou,
    folders: lined.map(({ bucket, rank }) => ({ bucket: bucket.key, rank })),
    folded: happening.slice(room).map(({ bucket }) => bucket.key),
    everythingElse: {
      sessions: rest.length,
      folders: new Set(
        rest.flatMap((entry) =>
          entry.bucket === SESSION_FOCUS_UNFILED_BUCKET ? [] : [entry.bucket]
        )
      ).size
    },
    lines: (needsYou > 0 ? 1 : 0) + lined.length + 1
  }
}
