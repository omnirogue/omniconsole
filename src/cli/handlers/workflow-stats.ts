import { readFileSync } from 'node:fs'
import {
  discoverBlindReview,
  discoverStats,
  discoverStatsExportSchema,
  mergeDiscoverExports
} from '../../shared/workflow-discover-stats'
/**
 * `omni workflow stats` — the judging record summed up: which steps, judges, models and rubrics
 * win, how often JEV escalates, and what it costs. A report only. The app reads its own record
 * over RPC and changes nothing; nothing reads these numbers back to change a seat, a rubric or a
 * threshold, because tuning against a judge gets gamed.
 */

import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { formatWorkflowJudgingStats } from '../workflow-stats-format'
import { LOCAL_WORKFLOW_METHODS } from '../../shared/local-workflow-rpc'
import {
  workflowJudgingStatsRequestSchema,
  type WorkflowJudgingStats,
  type WorkflowJudgingStatsRequest
} from '../../shared/workflow-judging-stats'

type Flags = Map<string, string | boolean>

function text(flags: Flags, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** `--since`: a date (2026-09-20) or a date and time, read as the record's own clock (UTC). */
function sinceOf(flags: Flags): number | undefined {
  const value = text(flags, 'since')
  if (value === undefined) {
    if (flags.has('since')) {
      throw new RuntimeClientError('invalid_argument', '--since needs a date, like 2026-09-20.')
    }
    return undefined
  }
  const at = Date.parse(value)
  if (!Number.isFinite(at)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--since: ${value} is not a date; write it like 2026-09-20 or 2026-09-20T09:00Z.`
    )
  }
  return at
}

/** The request the flags describe, checked here so a mistake is named before the app is asked. */
export function statsRequestFromFlags(flags: Flags): WorkflowJudgingStatsRequest {
  const template = text(flags, 'template')
  if (flags.has('template') && !template) {
    throw new RuntimeClientError('invalid_argument', '--template needs a template name.')
  }
  const since = sinceOf(flags)
  const parsed = workflowJudgingStatsRequestSchema.safeParse({
    ...(template ? { template } : {}),
    ...(since !== undefined ? { since } : {})
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new RuntimeClientError(
      'invalid_argument',
      `--${String(issue.path[0] ?? 'template')}: ${issue.message}`
    )
  }
  return parsed.data
}

const workflowStats: CommandHandler = async (ctx) => {
  const request = statsRequestFromFlags(ctx.flags)
  const merge = text(ctx.flags, 'merge')
  const blind = text(ctx.flags, 'blind-review')
  if (
    (ctx.flags.has('merge') && !merge) ||
    (ctx.flags.has('blind-review') && (!blind || !/^[1-9]\d*$/.test(blind) || Number(blind) > 1000))
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--merge needs comma-separated export files; --blind-review needs a sample count from 1 to 1000 per verdict.'
    )
  }
  const stats = merge
    ? undefined
    : (await ctx.client.call<WorkflowJudgingStats>(LOCAL_WORKFLOW_METHODS.stats, request)).result
  const data = merge
    ? mergeDiscoverExports(
        merge
          .split(',')
          .map((file) =>
            discoverStatsExportSchema.parse(JSON.parse(readFileSync(file.trim(), 'utf8')))
          )
      )
    : stats?.discover?.export
  if (ctx.flags.has('export') || blind || merge) {
    if (!data) {
      throw new RuntimeClientError(
        'update_required',
        'This host does not export Discover measurements yet; update it first.'
      )
    }
    const filtered = {
      ...data,
      runs: data.runs.filter(
        (run) =>
          (!request.template || run.template === request.template) &&
          (request.since === undefined || run.at >= request.since)
      )
    }
    console.log(
      JSON.stringify(
        blind
          ? discoverBlindReview(filtered, Number(blind))
          : ctx.flags.has('export')
            ? filtered
            : discoverStats(filtered),
        null,
        2
      )
    )
    return
  }
  console.log(ctx.json ? JSON.stringify(stats, null, 2) : formatWorkflowJudgingStats(stats!))
}

export const WORKFLOW_STATS_HANDLERS: Record<string, CommandHandler> = {
  'workflow stats': workflowStats
}
