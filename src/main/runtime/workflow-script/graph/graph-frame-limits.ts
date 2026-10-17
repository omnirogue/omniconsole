import type { WorkflowStep } from '../../../../shared/workflow-graph'
import type { GraphOkOutput } from './graph-plan-types'
import { graphBriefBullets, graphBriefRubric, GRAPH_DEFAULT_OPTION_RUBRIC } from './graph-triage'

/**
 * A frame's hard limits as the run reads them: listed (one bullet each), explicitly none, or
 * unreadable (no such heading, or prose that is not a list). Only an explicit "None stated."
 * means there are none; anything unreadable is never taken for "no limits".
 */
export type GraphFrameLimits =
  | { state: 'listed'; limits: string[] }
  | { state: 'none' }
  | { state: 'unreadable' }

const NONE = /^none(?: stated)?\.?$/i
const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/

export function graphFrameLimits(markdown: string | undefined): GraphFrameLimits {
  const lines = (markdown ?? '').split('\n')
  const start = lines.findIndex((line) => /^#{1,6}\s/.test(line) && /\bhard limits?\b/i.test(line))
  if (start === -1) {
    return { state: 'unreadable' }
  }
  const limits = graphBriefBullets(markdown!, /\bhard limits?\b/i)
    .map((line) => line.replace(bullet, '').trim())
    .filter((line) => !NONE.test(line))
  if (limits.length) {
    return { state: 'listed', limits }
  }
  // The heading's own line may carry the answer ("## Hard limits: None stated.").
  const body = [lines[start]!.replace(/^#{1,6}\s+[^:]*:?/, ''), ...lines.slice(start + 1)]
  const end = body.findIndex((line, index) => index > 0 && /^#{1,6}\s/.test(line))
  const text = (end === -1 ? body : body.slice(0, end)).join(' ').replace(bullet, '').trim()
  return NONE.test(text) ? { state: 'none' } : { state: 'unreadable' }
}

/** One screen line per hard limit, so no limit is ever cut to fit a shared line. */
export const GRAPH_HARD_LIMIT_PREFIX = '- Does it stay within this hard limit:'
/** JEV scores at most 12 rubric lines, each at most 300 characters. */
const MAX_LINES = 12
const MAX_LINE = 300

export type GraphShortlistPlan = {
  rubric: string
  limitLines: number
  unscreened: string[]
  limits: GraphFrameLimits
}

/**
 * The shortlist's rubric: each hard limit on its own line, then the frame's rubric (or the option
 * default). Limits that do not fit JEV's lines are named, never dropped silently.
 */
export function graphShortlistRubric(frame: string | undefined): GraphShortlistPlan {
  const quality = ((frame && graphBriefRubric(frame)) ?? GRAPH_DEFAULT_OPTION_RUBRIC).split('\n')
  const limits = graphFrameLimits(frame)
  const listed = limits.state === 'listed' ? limits.limits : []
  const room = Math.max(0, MAX_LINES - quality.length)
  const lines: string[] = []
  const unscreened: string[] = []
  for (const limit of listed) {
    const line = `${GRAPH_HARD_LIMIT_PREFIX} ${limit.replace(/[.;]+$/, '')}?`
    if (line.length <= MAX_LINE && lines.length < room) {
      lines.push(line)
    } else {
      unscreened.push(limit)
    }
  }
  return { rubric: [...lines, ...quality].join('\n'), limitLines: lines.length, unscreened, limits }
}

/** A shortlisting step's plan, from the frame it reads (`screen.rubricFrom`). */
export function graphShortlistPlan(
  step: WorkflowStep,
  settled: readonly { id: string; output: GraphOkOutput }[]
): GraphShortlistPlan {
  const from = step.forEach?.screen?.rubricFrom
  const frame = settled.find((input) => input.id === from)?.output.run.texts?.[0]?.markdown
  return graphShortlistRubric(frame)
}
