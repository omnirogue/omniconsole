/**
 * Severity counts in a reviewer report. The reviewer brief asks for findings ranked BLOCKER,
 * MAJOR, MINOR, NIT; reports write them either inline (`- **MAJOR** src/a.ts:12 …`), as a
 * section heading (`### MAJOR`) over a list, or in a sentence ("1 MAJOR … two NITs"). Only the
 * upper-case words count, so prose such as "Minor tweak" is not read as a finding. The chips
 * summarise; the report itself stays the record.
 */

export const BUILD_REVIEW_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const
export type BuildReviewSeverity = (typeof BUILD_REVIEW_SEVERITIES)[number]
export type BuildReviewSeverityCounts = Record<BuildReviewSeverity, number>

const SEVERITY_LINE = /^\[?(BLOCKER|MAJOR|MINOR|NIT)S?\b\]?(?:\s*\(\d+\))?\s*[:\-–—.)]*\s*(.*)$/
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/
const HEADING = /^\s*#{1,6}\s/
const NOTHING = /^(?:none|n\/a|nothing|no findings|0|-|—)\.?$/i

/** A line with the markdown around its first word removed: quotes, headings, bullets, emphasis. */
function leadText(line: string): string {
  return line
    .replace(/[*`_]/g, '')
    .replace(/^(?:\s*(?:>|#{1,6}|[-+]|\d+[.)]))+\s*/, '')
    .trim()
}

const NUMBER_WORDS: Record<string, number> = {
  no: 0,
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10
}

// A count, at most one lower-case word ("unresolved"), then an upper-case severity. Why no `i`
// flag: the severity must stay upper case, and the one word must not swallow a second severity.
// Why the look-behind: `src/a.ts:12 MAJOR` is a location, not twelve findings. Why no "a": "not
// a BLOCKER" and "from a MAJOR to a MINOR" name a severity, not a finding.
const COUNTED_MENTION =
  /(?<![\w:./#-])(\d+|[Nn]o|[Zz]ero|[Oo]ne|[Tt]wo|[Tt]hree|[Ff]our|[Ff]ive|[Ss]ix|[Ss]even|[Ee]ight|[Nn]ine|[Tt]en)\s+(?:[a-z][a-z-]*\s+)?(BLOCKER|MAJOR|MINOR|NIT)[Ss]?\b/g
// "The 2 MAJORs", "not one BLOCKER": findings named again, or denied, rather than counted.
const NOT_A_TALLY = /\b(?:the|those|these|earlier|previous|prior|not|never)\s+$/i
// "… 2 MAJORs fixed", "… 2 MAJORs from round 1 are fixed": findings that are gone count none.
const SETTLED_AFTER =
  /^\s*(?:fixed|resolved|addressed)\b|^[^,;.]*?\b(?:are|is|were|was|been|now)\s+(?:all\s+)?(?:fixed|resolved|addressed)\b/i

/**
 * Counts a reviewer states in prose ("1 MAJOR … two NITs"). The highest per severity, not the
 * sum: a summary and the paragraph under it name the same findings again.
 */
function statedSeverityCounts(text: string): BuildReviewSeverityCounts {
  const counts = emptySeverityCounts()
  for (const match of text.matchAll(COUNTED_MENTION)) {
    const before = text.slice(Math.max(0, match.index - 24), match.index)
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 160)
    if (NOT_A_TALLY.test(before) || SETTLED_AFTER.test(after)) {
      continue
    }
    const word = match[1]!
    const count = /^\d+$/.test(word) ? Number(word) : (NUMBER_WORDS[word.toLowerCase()] ?? 0)
    const severity = severityOf(match[2]!)
    counts[severity] = Math.max(counts[severity], count)
  }
  return counts
}

function severityOf(word: string): BuildReviewSeverity {
  return word.toLowerCase() as BuildReviewSeverity
}

export function emptySeverityCounts(): BuildReviewSeverityCounts {
  return { blocker: 0, major: 0, minor: 0, nit: 0 }
}

/** Listed findings and the counts stated in prose (the subject's too), the higher of the two. */
export function reportSeverityCounts(
  body: string | null | undefined,
  subject?: string | null
): BuildReviewSeverityCounts {
  const listed = listedSeverityCounts(body)
  const stated = statedSeverityCounts(`${subject ?? ''}\n${body ?? ''}`)
  const counts = emptySeverityCounts()
  for (const severity of BUILD_REVIEW_SEVERITIES) {
    counts[severity] = Math.max(listed[severity], stated[severity])
  }
  return counts
}

function listedSeverityCounts(body: string | null | undefined): BuildReviewSeverityCounts {
  const counts = emptySeverityCounts()
  // The open section heading and the indentation its own list items use.
  let section: { severity: BuildReviewSeverity; indent: number | null } | null = null
  for (const line of (body ?? '').split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    const match = SEVERITY_LINE.exec(leadText(line))
    if (match) {
      const severity = severityOf(match[1]!)
      const rest = match[2]!.trim()
      if (!rest) {
        section = { severity, indent: null }
      } else {
        section = null
        if (!NOTHING.test(rest)) {
          counts[severity] += 1
        }
      }
      continue
    }
    if (!section) {
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      const indent = item[1]!.length
      section.indent ??= indent
      if (indent === section.indent && !NOTHING.test(leadText(line))) {
        counts[section.severity] += 1
      }
      continue
    }
    // Indented text continues the previous item; a heading or a flush paragraph ends the section.
    if (HEADING.test(line) || !/^\s/.test(line)) {
      section = null
    }
  }
  return counts
}
