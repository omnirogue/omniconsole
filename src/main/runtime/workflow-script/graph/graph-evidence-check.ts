import type { LocalWorkflowEvidenceStatus } from '../../../../shared/local-workflow-view'
import { readWorkspaceWholeFile } from '../../workspace-whole-file'
import type { GraphPreVerify, GraphPreVerifyItem } from './graph-pre-verify'

/** `unreadable` is never evidence either way; `not-code`: no path:line; `unquoted`: no quote. */
export type GraphEvidenceStatus = LocalWorkflowEvidenceStatus

export type GraphEvidenceCheck = {
  status: GraphEvidenceStatus
  /** A merged member's quote can come from a different reported location. */
  location?: string
  excerpt?: string
  /** Where the quote starts (found, moved), else the line the finder named. */
  line?: number
  /** The file's real lines around `line`, numbered. */
  context?: string
  /** Evidence rules 2: its citations and absence searches, checked before any reviewer. */
  preVerify?: GraphPreVerify
}

/** Evidence rules the run was admitted under (EVIDENCE_RULES); absent: quotes only. */
export type GraphEvidenceFields = { evidenceRules?: number }

/** One quote to check: the item, the file and line it names, and its verbatim excerpt. */
export type GraphEvidenceRequest = {
  items: { key: string; file: string; line: number; excerpt: string }[]
  /** Evidence rules 2 only, so an older run's request (and its record) is unchanged. */
  preVerify?: GraphPreVerifyItem[]
}

/** A quote this close to the named line counts as at the line. */
const NEAR_LINES = 30
const CONTEXT_LINES = 12
const CONTEXT_LINE_CHARS = 300
const MAX_OCCURRENCES = 2000

/** `path:line` (also `path:line:col`, `path:line-end`, `path#Lline`) from a location, or none. */
export function graphEvidenceLocation(
  location: string
): { file: string; line: number } | undefined {
  const first = location
    .trim()
    .split(/[\s,;]+/)[0]
    ?.replace(/^[`'"(]+|[`'".,)]+$/g, '')
  const match = first ? /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+))(?:[-–]L?\d+)?$/.exec(first) : null
  const line = Number(match?.[2] ?? match?.[3])
  if (!match || !Number.isInteger(line) || line < 1) {
    return undefined
  }
  return { file: match[1]!.replace(/^\.[\\/]/, ''), line }
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The excerpt's parts, split where the finder elided code with "..." or "…". */
export function graphExcerptFragments(excerpt: string): string[] {
  return excerpt
    .split(/\.\.\.|…/)
    .map(squash)
    .filter(Boolean)
}

/** The file with whitespace collapsed, and where each non-blank line starts in it. */
function flatten(lines: readonly string[]): { text: string; starts: number[]; numbers: number[] } {
  const parts: string[] = []
  const starts: number[] = []
  const numbers: number[] = []
  let length = 0
  lines.forEach((line, index) => {
    const flat = squash(line)
    if (!flat) {
      return
    }
    length += parts.length ? 1 : 0
    starts.push(length)
    numbers.push(index + 1)
    parts.push(flat)
    length += flat.length
  })
  return { text: parts.join(' '), starts, numbers }
}

function lineAt(flat: { starts: number[]; numbers: number[] }, offset: number): number {
  let low = 0
  let high = flat.starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (flat.starts[middle]! <= offset) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  return flat.numbers[low] ?? 1
}

function context(lines: readonly string[], center: number): string {
  const middle = Math.min(Math.max(center, 1), lines.length)
  const first = Math.max(1, middle - CONTEXT_LINES)
  const last = Math.min(lines.length, middle + CONTEXT_LINES)
  const rows: string[] = []
  for (let number = first; number <= last; number++) {
    const text = lines[number - 1]!
    rows.push(
      `${number} | ${text.length > CONTEXT_LINE_CHARS ? `${text.slice(0, CONTEXT_LINE_CHARS)} …` : text}`
    )
  }
  return rows.join('\n')
}

/** The match nearest the named line decides found (within 30 lines) or moved; none is missing. */
export function graphMatchExcerpt(
  content: string,
  excerpt: string,
  line: number
): GraphEvidenceCheck {
  const lines = content.split(/\r?\n/)
  const fragments = graphExcerptFragments(excerpt)
  const flat = flatten(lines)
  let best: { start: number; end: number; distance: number } | undefined
  let from = 0
  for (let seen = 0; fragments.length && seen < MAX_OCCURRENCES; seen++) {
    const start = flat.text.indexOf(fragments[0]!, from)
    if (start === -1) {
      break
    }
    let end = start + fragments[0]!.length
    for (const fragment of fragments.slice(1)) {
      const at = flat.text.indexOf(fragment, end)
      end = at === -1 ? -1 : at + fragment.length
      if (end === -1) {
        break
      }
    }
    // Later starts only find the rest later, so once the rest is absent it is absent for all.
    if (end === -1) {
      break
    }
    const first = lineAt(flat, start)
    const last = lineAt(flat, end - 1)
    const distance = line < first ? first - line : line > last ? line - last : 0
    if (!best || distance < best.distance) {
      best = { start: first, end: last, distance }
    }
    from = start + 1
  }
  if (!best) {
    return { status: 'missing', line, context: context(lines, line) }
  }
  return {
    status: best.distance <= NEAR_LINES ? 'found' : 'moved',
    line: best.start,
    context: context(lines, best.start)
  }
}

/** A file that cannot be read in full is `unreadable`: never a verdict on the quote itself. */
export async function checkGraphEvidence(
  request: GraphEvidenceRequest,
  root: string | null,
  read: typeof readWorkspaceWholeFile = readWorkspaceWholeFile
): Promise<Record<string, GraphEvidenceCheck>> {
  const files = new Map<string, Promise<string | null>>()
  const checks: Record<string, GraphEvidenceCheck> = {}
  for (const item of request.items) {
    if (!files.has(item.file)) {
      files.set(item.file, root ? read(root, item.file) : Promise.resolve(null))
    }
    const content = await files.get(item.file)!
    checks[item.key] =
      content === null
        ? { status: 'unreadable', line: item.line }
        : graphMatchExcerpt(content, item.excerpt, item.line)
  }
  return checks
}
