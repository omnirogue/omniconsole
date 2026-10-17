import { once } from 'node:events'
import {
  JEV_RECORD_METHODS,
  JEV_RECORDS_RUNTIME_CAPABILITY,
  JEV_RECORDS_LIST_MAX,
  isRealCalendarTime,
  jevOutcomeInputSchema,
  jevRecordKeySchema
} from '../../shared/jev-ledger'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { reportCliError } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { requireJevRuntimeCapability } from './jev-capability'
import { readJevJsonInput } from './jev-rubrics'

// Why: a time without a zone would be read in the CLI machine's local time.
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/
const CALLER = /^[a-zA-Z0-9_.:-]{1,96}$/

const invalid = (message: string) => new RuntimeClientError('invalid_argument', message)
const requireRecords = (ctx: HandlerContext): Promise<void> =>
  requireJevRuntimeCapability(ctx, JEV_RECORDS_RUNTIME_CAPABILITY, 'JEV records and outcomes')

function since(ctx: HandlerContext): { since?: string } {
  const value = ctx.flags.get('since')
  if (value === undefined) {
    return {}
  }
  if (typeof value !== 'string' || !ISO_8601.test(value) || !isRealCalendarTime(value)) {
    throw invalid(
      '--since needs an ISO 8601 date or time, such as 2026-10-03 or 2026-10-03T12:00:00Z.'
    )
  }
  return { since: new Date(value).toISOString() }
}

function listParams(ctx: HandlerContext) {
  const caller = ctx.flags.get('caller')
  const limit = ctx.flags.get('limit')
  if (caller !== undefined && (typeof caller !== 'string' || !CALLER.test(caller))) {
    throw invalid('--caller needs a feature id such as jev.rubrics.evaluate.')
  }
  const count = typeof limit === 'string' && /^\d+$/.test(limit) ? Number(limit) : Number.NaN
  if (limit !== undefined && !(count >= 1 && count <= JEV_RECORDS_LIST_MAX)) {
    throw invalid(`--limit needs a whole number from 1 to ${JEV_RECORDS_LIST_MAX}.`)
  }
  return {
    ...since(ctx),
    ...(caller === undefined ? {} : { caller }),
    ...(limit === undefined ? {} : { limit: count })
  }
}

const list: CommandHandler = async (ctx) => {
  const params = listParams(ctx)
  await requireRecords(ctx)
  const response = await ctx.client.call(JEV_RECORD_METHODS.list, params)
  console.log(JSON.stringify(response.result, null, 2))
}

/**
 * NDJSON on stdout, page by page, so a large ledger never becomes one reply. Errors go to
 * stderr only (exit code 1): stdout is often redirected to a rows file, even with --json.
 */
const exportRows: CommandHandler = async (ctx) => {
  try {
    const filter = since(ctx)
    await requireRecords(ctx)
    let cursor: string | undefined
    do {
      const response = await ctx.client.call<{ rows: unknown[]; cursor: string | null }>(
        JEV_RECORD_METHODS.export,
        { ...filter, ...(cursor ? { cursor } : {}) }
      )
      const { rows, cursor: next } = response.result
      if (next && rows.length === 0) {
        throw new RuntimeClientError('runtime_error', 'The JEV records export made no progress.')
      }
      const text = rows.map((row) => `${JSON.stringify(row)}\n`).join('')
      if (text && !process.stdout.write(text)) {
        await once(process.stdout, 'drain')
      }
      cursor = next ?? undefined
    } while (cursor)
  } catch (error) {
    reportCliError(error, ctx.json, { commandPath: ['jev', 'records', 'export'] }, 'stderr')
    process.exitCode = 1
  }
}

const outcome: CommandHandler = async (ctx) => {
  const key = jevRecordKeySchema.safeParse(ctx.flags.get('key'))
  if (!key.success) {
    throw invalid(
      'Pass the record key, for example `omni jev outcome jev-rubric:<request_id> --file outcome.json`.'
    )
  }
  await requireRecords(ctx)
  const parsed = jevOutcomeInputSchema.safeParse(await readJevJsonInput(ctx))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalid(
      issue ? `${issue.path.join('.') || 'outcome'}: ${issue.message}` : 'Invalid outcome.'
    )
  }
  const response = await ctx.client.call(JEV_RECORD_METHODS.outcome, {
    record_key: key.data,
    outcome: parsed.data
  })
  console.log(JSON.stringify(response.result, null, 2))
}

export const JEV_RECORD_HANDLERS: Record<string, CommandHandler> = {
  'jev records list': list,
  'jev records export': exportRows,
  'jev outcome': outcome
}
