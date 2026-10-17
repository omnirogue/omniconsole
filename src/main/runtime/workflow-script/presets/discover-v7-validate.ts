import {
  discoverV7Path,
  type DiscoverV7Area,
  type DiscoverV7Batch,
  type DiscoverV7Config,
  type DiscoverV7Repeats,
  type DiscoverV7Vote
} from './discover-v7-plan'

/**
 * Semantic gates for Discover revision 7 answers. A finder that answers in seconds with
 * `{"title":"placeholder","trigger":"t",...}` passes the schema; these checks reject it so the
 * call retries with the problem named, instead of the stub becoming a card that gets verified.
 */

const PLACEHOLDER_WORDS = new Set(
  (
    'placeholder placeholders todo tbd tba fixme xxx lorem ipsum dolor dummy stub sample example ' +
    'foo bar baz na none null undefined unknown test here text value finding defect bug issue ' +
    'title file line trigger scenario evidence fix reason description details severity'
  ).split(' ')
)
/** Only the path as a whole: a real file may well be called test.ts or example.ts. */
const PLACEHOLDER_PATHS = new Set(
  '. - ... n/a na none null undefined unknown placeholder tbd todo file path xxx'.split(' ')
)
/** Shortest text a real report gives each field; wide scripts count three units a character. */
const MIN_UNITS = { title: 8, trigger: 8, scenario: 12, evidence: 12, fix: 6, reason: 10 }
type Field = keyof typeof MIN_UNITS
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const MAX_PROBLEMS = 4

const clip = (text: string) => (text.length > 60 ? `${text.slice(0, 60)}…` : text)

function units(text: string): number {
  let total = 0
  for (const character of text) {
    total += WIDE.test(character) ? 3 : 1
  }
  return total
}

/** No word at all, or only placeholder words and single letters ("TODO", "n/a", "t"). */
function isPlaceholder(text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  return words.every(
    (word) => (word.length === 1 && !WIDE.test(word)) || PLACEHOLDER_WORDS.has(word)
  )
}

function textProblem(field: Field, value: string): string | null {
  const text = value.trim()
  if (isPlaceholder(text)) {
    return `${field} is a placeholder ("${clip(text)}")`
  }
  return units(text) < MIN_UNITS[field]
    ? `${field} "${clip(text)}" is too short to describe a real defect`
    : null
}

function fileProblem(file: string, workspaceRoot?: string): string | null {
  const path = discoverV7Path(file, workspaceRoot)
  if (/^([a-z]:)?\//i.test(path) || path.startsWith('~') || path.includes('://')) {
    return `file "${clip(file)}" must be a path relative to the workspace`
  }
  if (
    !path ||
    path.endsWith('/') ||
    path.split('/').some((segment) => segment === '..') ||
    /[<>*?|"]/.test(path) ||
    /(^|\/)path\/to\//i.test(path) ||
    PLACEHOLDER_PATHS.has(path.toLowerCase())
  ) {
    return `file "${clip(file)}" does not name a real file in the workspace`
  }
  return null
}

/** Names what is wrong with the first few findings, or null when every finding is a real report. */
export function discoverV7FindingsProblem(value: unknown, workspaceRoot?: string): string | null {
  const problems: string[] = []
  ;(value as DiscoverV7Batch).findings.forEach((finding, index) => {
    const found = [
      textProblem('title', finding.title),
      fileProblem(finding.file, workspaceRoot),
      Number.isInteger(finding.line) && finding.line >= 1 ? null : 'line must be 1 or more',
      textProblem('trigger', finding.trigger),
      textProblem('scenario', finding.scenario),
      textProblem('evidence', finding.evidence),
      textProblem('fix', finding.fix)
    ].filter((problem): problem is string => problem !== null)
    if (found.length) {
      problems.push(`finding ${index + 1} ("${clip(finding.title.trim())}"): ${found.join(', ')}`)
    }
  })
  if (!problems.length) {
    return null
  }
  const more = problems.length > MAX_PROBLEMS ? `; and ${problems.length - MAX_PROBLEMS} more` : ''
  return `Report only real defects you found in the code, with a concrete title, trigger, scenario, evidence (file:line and what the code does) and fix. Rejected ${problems.slice(0, MAX_PROBLEMS).join('; ')}${more}`
}

/**
 * A vote must cite the code it judged and say why: `{"verdict":"unjudged","evidence":""}` in
 * seconds opened nothing, so it retries with the problem named. A placeholder such as "n/a" or
 * "." is not a file read. Frozen verifiers need no filesRead.
 */
export function discoverV7VoteProblem(
  value: unknown,
  access: DiscoverV7Config['access']
): string | null {
  const vote = value as DiscoverV7Vote
  const read = (vote.filesRead ?? []).filter(
    (path) => path.trim() && !PLACEHOLDER_PATHS.has(path.trim().toLowerCase())
  )
  const missing = [
    access === 'workspace-read' && !read.length ? 'Set filesRead to every file you opened.' : '',
    isPlaceholder(vote.evidence.trim())
      ? 'Give the evidence: file:line and what the code there does.'
      : ''
  ].filter(Boolean)
  const reason = textProblem('reason', vote.reason)
  const problems = [
    missing.length
      ? `${access === 'frozen' ? 'Read the attached files' : 'Open the files'} before voting; you cited none. ${missing.join(' ')}`
      : '',
    reason
      ? `Give the reason for your verdict from the code you read: ${reason.replace('a real defect', 'a verdict')}`
      : ''
  ].filter(Boolean)
  return problems.length ? problems.join(' ') : null
}

/** A path without a trailing `:line` or `/`; "." or nothing stands for the whole workspace. */
function scopePath(path: string, workspaceRoot?: string): string {
  const plain = discoverV7Path(path, workspaceRoot)
    .replace(/:\d+(-\d+)?$/, '')
    .replace(/\/+$/, '')
  return plain === '.' ? '' : plain
}

const GLOB_CHAR = /[*?[{]/

/**
 * Whether a reported file lies under one area entry: the entry itself, a file in that folder, or,
 * for an entry the scout wrote as a glob, a path starting with its literal lead ("src/foo/" of
 * "src/foo/*.ts"; "**" alone is the whole workspace).
 */
function inAreaEntry(file: string, entry: string, workspaceRoot?: string): boolean {
  const glob = entry.search(GLOB_CHAR)
  if (glob >= 0) {
    return file.startsWith(discoverV7Path(entry.slice(0, glob), workspaceRoot))
  }
  const scope = scopePath(entry, workspaceRoot)
  return !scope || file === scope || file.startsWith(`${scope}/`)
}

/**
 * A workspace-read finder must say which files it opened, and at least one must lie in its area
 * (an area entry may be a folder or a glob). An answer that lists none came back without reading
 * anything: it is retried, not accepted as "nothing found". Frozen finders read attached text and
 * are exempt.
 */
export function discoverV7FilesReadProblem(
  value: unknown,
  area: DiscoverV7Area,
  workspaceRoot?: string
): string | null {
  const read = ((value as DiscoverV7Batch).filesRead ?? []).filter((path) => path.trim())
  if (!read.length) {
    return "Open the area's files before answering; you reported none."
  }
  const inside = read.some((path) => {
    const file = scopePath(path, workspaceRoot)
    return area.files.some((entry) => inAreaEntry(file, entry, workspaceRoot))
  })
  return inside
    ? null
    : `Open the area's files before answering; none of the files you reported is in this area (${clip(area.files.join(', '))}).`
}

/** A repeat check must put every finding it was given in exactly one group, and nothing else. */
export function discoverV7RepeatsProblem(value: unknown, ids: readonly string[]): string | null {
  const expected = new Set(ids)
  const seen = new Set<string>()
  const unknown: string[] = []
  const twice: string[] = []
  for (const group of (value as DiscoverV7Repeats).groups) {
    for (const id of group.findingIds) {
      if (!expected.has(id)) {
        unknown.push(id)
      } else if (seen.has(id)) {
        twice.push(id)
      }
      seen.add(id)
    }
  }
  const missing = ids.filter((id) => !seen.has(id))
  const problems = [
    unknown.length ? `unknown ids ${unknown.join(', ')}` : '',
    twice.length ? `ids in more than one group ${[...new Set(twice)].join(', ')}` : '',
    missing.length ? `missing ids ${missing.join(', ')}` : ''
  ].filter(Boolean)
  return problems.length
    ? `Put every finding id in exactly one group and use only the ids given: ${problems.join('; ')}`
    : null
}
