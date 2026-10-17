import {
  discoverV7Path,
  type DiscoverV7RawFinding,
  type DiscoverV7Record
} from './discover-v7-plan'

/**
 * Near-duplicate rules for Discover revision 7. Two reports describe one defect when they name
 * the same file, their line ranges overlap or lie within DISCOVER_V7_NEAR_LINES of each other,
 * and their titles share at least DISCOVER_V7_TITLE_OVERLAP of their words (Jaccard, after
 * stopwords). A report is only ever matched against a report that was verified, never against
 * another repeat, so matches do not chain past those bounds. Everything here is a pure function of
 * the findings, so the program and its replay decide the same duplicates whatever order finders
 * finish in.
 */
export const DISCOVER_V7_NEAR_LINES = 12
export const DISCOVER_V7_TITLE_OVERLAP = 0.5

const STOPWORDS = new Set(
  (
    'a an and are as at be been being but by can could did do does for from has have if in into ' +
    'is it its may might more most no not of on once only or so than that the their then there ' +
    'these this those to too via was were when where which while who will with without would'
  ).split(' ')
)

type Signature = { root: string | undefined; path: string; start: number; end: number }
type TitleWords = { words: Set<string>; title: string }
const signatures = new WeakMap<DiscoverV7RawFinding, Signature>()
const titles = new WeakMap<DiscoverV7RawFinding, TitleWords>()

/**
 * Title words: camelCase and snake_case split, lower case, no stopwords, a plural s dropped.
 * Stopwords go first, so "does" and "this" never survive as "doe" and "thi".
 */
export function discoverV7TitleWords(title: string): Set<string> {
  return new Set(
    title
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => !STOPWORDS.has(word))
      .map((word) => (word.length > 3 && /[^s]s$/.test(word) ? word.slice(0, -1) : word))
      .filter((word) => word.length > 1 && !STOPWORDS.has(word))
  )
}

function titleWords(finding: DiscoverV7RawFinding): TitleWords {
  let cached = titles.get(finding)
  if (!cached) {
    cached = {
      words: discoverV7TitleWords(finding.title),
      title: finding.title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
    }
    titles.set(finding, cached)
  }
  return cached
}

function signature(finding: DiscoverV7RawFinding, root: string | undefined): Signature {
  let cached = signatures.get(finding)
  if (!cached || cached.root !== root) {
    const end = finding.endLine !== null && finding.endLine > finding.line ? finding.endLine : null
    cached = {
      root,
      path: discoverV7Path(finding.file, root),
      start: finding.line,
      end: end ?? finding.line
    }
    signatures.set(finding, cached)
  }
  return cached
}

export function discoverV7Similar(
  left: DiscoverV7RawFinding,
  right: DiscoverV7RawFinding,
  workspaceRoot?: string
): boolean {
  const a = signature(left, workspaceRoot)
  const b = signature(right, workspaceRoot)
  if (a.path !== b.path || Math.max(a.start - b.end, b.start - a.end) > DISCOVER_V7_NEAR_LINES) {
    return false
  }
  const x = titleWords(left)
  const y = titleWords(right)
  if (!x.words.size || !y.words.size) {
    // A title of stopwords only still matches itself.
    return x.title === y.title
  }
  const shared = [...x.words].filter((word) => y.words.has(word)).length
  return shared / (x.words.size + y.words.size - shared) >= DISCOVER_V7_TITLE_OVERLAP
}

/**
 * The earliest verified report this finding repeats. Repeats are skipped: a report at line 34
 * that only resembles a repeat at 22 of an original at 10 is a report of its own.
 */
export function discoverV7DuplicateOf(
  records: readonly DiscoverV7Record[],
  finding: DiscoverV7RawFinding,
  workspaceRoot?: string
): string | undefined {
  return records.find(
    (record) => !record.duplicateOf && discoverV7Similar(record.finding, finding, workspaceRoot)
  )?.id
}
