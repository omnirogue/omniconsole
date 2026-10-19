import type { WorkflowWebCheck } from './workflow-graph-web'
/**
 * A report's value ranking of the reviewed results: why each matters and what to do next. The
 * writer appends it as one fenced `ranking` block; the app strips it from the report people read
 * and uses it to order the results they act on. Frontier models agreed on impact at 0.65 where
 * JEV reached 0.13, so the order comes from the writer, never from JEV.
 */
export type WorkflowReportRank = {
  key: string
  rank: number
  /** One line: why it matters. */
  why: string
  /** One line: the next concrete step. */
  next: string
  /** It can be acted on without the others. */
  independent?: boolean
  effort?: 'S' | 'M' | 'L'
  risk?: 'low' | 'medium' | 'high'
  /** A run that reads pages: the app's own check of each web quote in why and next. */
  webChecks?: WorkflowWebCheck[]
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

type WorkflowFencedBlock = { start: number; end: number; body: string }

/**
 * The last top-level fenced block with this tag, found line by line so a fence inside another
 * code block, or one without its own closing line, never swallows report text. An unclosed block
 * at the very end counts only when what follows it parses as the JSON array it should hold.
 */
export function workflowLastFencedBlock(
  markdown: string,
  tag: string
): WorkflowFencedBlock | undefined {
  let found: WorkflowFencedBlock | undefined
  let open: { fence: string; tag: string; start: number; bodyStart: number } | undefined
  let offset = 0
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const next = offset + raw.length + 1
    if (!open) {
      const fence = FENCE_OPEN.exec(line)
      if (fence) {
        open = { fence: fence[1]!, tag: fence[2]!, start: offset, bodyStart: next }
      }
    } else {
      const fence = FENCE_CLOSE.exec(line)
      if (fence && fence[1]![0] === open.fence[0] && fence[1]!.length >= open.fence.length) {
        if (open.tag === tag) {
          found = {
            start: open.start,
            end: Math.min(next, markdown.length),
            body: markdown.slice(open.bodyStart, offset)
          }
        }
        open = undefined
      }
    }
    offset = next
  }
  if (open?.tag === tag) {
    const body = markdown.slice(open.bodyStart)
    try {
      if (Array.isArray(JSON.parse(body))) {
        return { start: open.start, end: markdown.length, body }
      }
    } catch {
      // Not the ranking it should hold: leave the text as the writer wrote it.
    }
  }
  return found
}

// Why the original wording: every existing spec that ranks sends this text, and its saved prompt and
// request digests must replay byte for byte (graph-evidence-legacy.test.ts). New wording belongs in a
// separate instruction that only new saved specs enable, like WORKFLOW_REPORT_ESTIMATES_INSTRUCTION.
export const WORKFLOW_REPORT_RANKING_INSTRUCTION = [
  'After the report, append exactly one fenced block tagged `ranking` (it is read by the app and hidden from people):',
  '```ranking',
  '[{"key": "<result key>", "rank": 1, "why": "<one line: why it matters>", "next": "<one line: the next concrete step>", "independent": true}]',
  '```',
  'Rank by value for the goal, 1 first. Include every confirmed result exactly once, and any unverified result worth acting on; use the keys exactly as listed (e.g. find.r1.3). Nothing may follow the block.'
].join('\n')

/** Enabled in new saved specs; existing runs keep their original prompt and request digests. */
export const WORKFLOW_REPORT_ESTIMATES_INSTRUCTION =
  'In every ranking row also include effort ("S", "M" or "L") and risk ("low", "medium" or "high") for the next step.'

/** The report people read, without its last `ranking` block, and that ranking when it parses. */
export function splitWorkflowReportRanking(markdown: string): {
  markdown: string
  ranking?: WorkflowReportRank[]
} {
  const block = workflowLastFencedBlock(markdown, 'ranking')
  if (!block) {
    return { markdown }
  }
  // Kept apart by a blank line, so the text on either side never runs into one paragraph.
  const body = [markdown.slice(0, block.start).trim(), markdown.slice(block.end).trim()]
    .filter(Boolean)
    .join('\n\n')
  let raw: unknown
  try {
    raw = JSON.parse(block.body)
  } catch {
    return { markdown: body }
  }
  if (!Array.isArray(raw)) {
    return { markdown: body }
  }
  const ranking = raw.flatMap((entry): WorkflowReportRank[] => {
    const row = (entry ?? {}) as Record<string, unknown>
    return typeof row.key === 'string' &&
      Number.isSafeInteger(row.rank) &&
      (row.rank as number) > 0 &&
      typeof row.why === 'string' &&
      typeof row.next === 'string'
      ? [
          {
            key: row.key,
            rank: row.rank as number,
            why: row.why.trim(),
            next: row.next.trim(),
            ...(typeof row.independent === 'boolean' ? { independent: row.independent } : {}),
            ...(['S', 'M', 'L'].includes(String(row.effort))
              ? { effort: row.effort as WorkflowReportRank['effort'] }
              : {}),
            ...(['low', 'medium', 'high'].includes(String(row.risk))
              ? { risk: row.risk as WorkflowReportRank['risk'] }
              : {})
          }
        ]
      : []
  })
  // Stable: rows the writer gave the same rank keep the order it wrote them in.
  return { markdown: body, ranking: [...ranking].sort((left, right) => left.rank - right.rank) }
}
