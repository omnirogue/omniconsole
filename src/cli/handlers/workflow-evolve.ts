/**
 * `omni workflow run evolve` — starts an Evolve run (jev-lab's OpenEvolve CLI on a fleet host)
 * through the runtime and follows it until the ledger settles it. Progress goes to stderr; the
 * report, or with --json the run record, to stdout.
 */

import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import {
  EVOLVE_RPC,
  EVOLVE_TARGETS,
  evolveStartRequestSchema,
  evolveStatusCommand,
  isEvolveRunActive,
  type EvolveRunRecord,
  type EvolveStartRequest
} from '../../shared/evolve-workflow'
import { evolvePhase, evolveStatusLines } from '../../shared/evolve-workflow-status'
import { workflowPlacementSummary } from '../../shared/local-workflow-placement'

type Flags = Map<string, string | boolean>
type Context = Parameters<CommandHandler>[0]

const START_TIMEOUT_MS = 120_000
const SUBMIT_WAIT_MS = 240_000
const POLL_MS = 5_000

const FLAG_OF_FIELD: Record<string, string> = {
  target: 'target',
  specPath: 'spec-path',
  checkout: 'checkout',
  iterations: 'iterations',
  patience: 'patience',
  seedFrom: 'seed-from',
  rubricFrom: 'rubric-from',
  usdCap: 'usd-cap',
  submittedBy: 'submitted-by',
  runsOn: 'runs-on',
  runsOnHost: 'host',
  forceHost: 'force-host',
  requestedBy: 'requested-by',
  requestedById: 'requested-by-id',
  request: 'request'
}

function text(flags: Flags, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function number(flags: Flags, name: string): number | undefined {
  const value = text(flags, name)
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new RuntimeClientError('invalid_argument', `--${name}: ${value} is not a number.`)
  }
  return parsed
}

/** `omni workflow run evolve` and `--template evolve` both name it. */
export function isEvolveRunFlags(flags: Flags): boolean {
  return (
    text(flags, 'template') === 'evolve' ||
    (!flags.has('template') && text(flags, 'prompt') === 'evolve')
  )
}

/** The Start the flags describe, checked here so a mistake is named before anything starts. */
export function evolveRequestFromFlags(flags: Flags): EvolveStartRequest {
  const specPath = text(flags, 'spec-path')
  const requestedBy = text(flags, 'requested-by')
  const request = text(flags, 'request')
  if (!!requestedBy !== !!request) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Give --requested-by "<person>" and --request "<their words>" together.'
    )
  }
  if (text(flags, 'force-host') && !text(flags, 'host')) {
    throw new RuntimeClientError('invalid_argument', '--force-host needs --host <name>.')
  }
  const parsed = evolveStartRequestSchema.safeParse({
    target: specPath ? 'spec' : (text(flags, 'target') ?? 'email-smoke'),
    ...(specPath ? { specPath } : {}),
    checkout: text(flags, 'checkout'),
    iterations: number(flags, 'iterations'),
    patience: number(flags, 'patience'),
    seedFrom: text(flags, 'seed-from'),
    rubricFrom: text(flags, 'rubric-from'),
    usdCap: number(flags, 'usd-cap'),
    submittedBy: text(flags, 'submitted-by'),
    // Always sent, as for every workflow Start: the fleet unless this computer is chosen.
    runsOn: text(flags, 'runs-on') ?? 'fleet',
    runsOnHost: text(flags, 'host'),
    forceHost: text(flags, 'force-host'),
    requestedBy,
    ...(flags.has('requested-by-id') ? { requestedById: flags.get('requested-by-id') } : {}),
    request
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    const field = String(issue.path[0] ?? 'target')
    throw new RuntimeClientError(
      'invalid_argument',
      field === 'target'
        ? `--target: choose one of ${Object.keys(EVOLVE_TARGETS).join(', ')}, or give --spec-path.`
        : `--${FLAG_OF_FIELD[field] ?? field}: ${issue.message}`
    )
  }
  return parsed.data
}

async function show(ctx: Context, id: string): Promise<EvolveRunRecord> {
  return (await ctx.client.call<{ run: EvolveRunRecord }>(EVOLVE_RPC.show, { id })).result.run
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reads the run until `done` holds or the time runs out; phase changes go to stderr. */
async function waitForRun(
  ctx: Context,
  run: EvolveRunRecord,
  done: (run: EvolveRunRecord) => boolean,
  limitMs = Number.POSITIVE_INFINITY
): Promise<EvolveRunRecord> {
  const began = Date.now()
  let last = ''
  while (!done(run) && Date.now() - began < limitMs) {
    const line = evolvePhase(run)
    if (!ctx.json && line !== last) {
      process.stderr.write(`${line}\n`)
      last = line
    }
    await sleep(POLL_MS)
    run = await show(ctx, run.id)
  }
  return run
}

/** What an agent reports once the spec is queued: both ids, the host, and how to read it. */
function startedDocument(run: EvolveRunRecord) {
  return {
    started: true,
    template: 'evolve',
    runId: run.id,
    state: run.state,
    ...(run.ledgerRunId ? { ledgerRunId: run.ledgerRunId } : {}),
    host: run.host,
    placement: run.placement,
    submittedBy: run.submittedBy,
    ...(run.request.requestedBy
      ? { requestedBy: run.request.requestedBy, request: run.request.request }
      : {}),
    ...(run.request.requestedById ? { requestedById: run.request.requestedById } : {}),
    ...(evolveStatusCommand(run) ? { statusCommand: evolveStatusCommand(run) } : {}),
    ...(run.error ? { error: run.error } : {})
  }
}

export const workflowRunEvolve: CommandHandler = async (ctx) => {
  const request = evolveRequestFromFlags(ctx.flags)
  let run: EvolveRunRecord
  try {
    run = (
      await ctx.client.call<{ run: EvolveRunRecord }>(EVOLVE_RPC.start, request, {
        timeoutMs: START_TIMEOUT_MS
      })
    ).result.run
  } catch (error) {
    // Only the host's own answer proves nothing was admitted; a timeout or a bad flag is not that.
    if (!ctx.json || !(error instanceof RuntimeClientError) || error.code !== 'runtime_error') {
      throw error
    }
    console.log(
      JSON.stringify({ started: false, template: 'evolve', reason: error.message }, null, 2)
    )
    process.exitCode = 1
    return
  }
  if (!ctx.json) {
    process.stderr.write(`Placed on ${workflowPlacementSummary(run.placement)}.\n`)
  }
  // Even without following, wait for the ledger run id: it is what an agent reports back.
  run = await waitForRun(
    ctx,
    run,
    (current) => !!current.ledgerRunId || !isEvolveRunActive(current.state),
    SUBMIT_WAIT_MS
  )
  if (ctx.flags.get('no-follow') === true) {
    console.log(
      ctx.json
        ? JSON.stringify(startedDocument(run), null, 2)
        : [
            `Evolve run ${run.id} on ${run.host}: ${evolvePhase(run)}.`,
            ...(run.ledgerRunId ? [`Ledger run ${run.ledgerRunId}.`] : []),
            ...(run.error ? [run.error] : [])
          ].join('\n')
    )
    if (run.state === 'failed') {
      process.exitCode = 1
    }
    return
  }
  run = await waitForRun(ctx, run, (current) => !isEvolveRunActive(current.state))
  console.log(ctx.json ? JSON.stringify(run, null, 2) : evolveStatusLines(run).join('\n'))
  if (run.state !== 'done') {
    process.exitCode = 1
  }
}

/** `omni workflow status evo_…`: the record, read without changing it. */
export const workflowStatusEvolve: CommandHandler = async (ctx) => {
  const run = await show(ctx, String(ctx.flags.get('run-id')).trim())
  console.log(ctx.json ? JSON.stringify(run, null, 2) : evolveStatusLines(run).join('\n'))
}
