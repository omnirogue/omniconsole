/**
 * `omni workflow run` — runs any built-in workflow template headless through the app, the way
 * `omni find-best` runs Find the best (local-workflow-cli-run.ts): the window opens the
 * conversation and starts it, and the command follows it to settled. Progress goes to stderr;
 * the report, or with --json everything a benchmark needs, goes to stdout.
 */

import {
  workflowRunFlagText as text,
  workflowRunLaunchFlags as launchFlags
} from './workflow-run-launch-flags'
import { workflowModelsFlagPlan } from '../../shared/workflow-models-flag'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { followLocalWorkflow, startLocalWorkflowFromCli } from '../local-workflow-cli-run'
import { RuntimeClientError } from '../runtime-client'
import {
  LOCAL_WORKFLOW_RUN_TEMPLATES,
  localWorkflowRunRequestSchema,
  type LocalWorkflowRunRequest
} from '../../shared/local-workflow-run-request'
import {
  LOCAL_WORKFLOW_METHODS,
  type LocalWorkflowRunStatus
} from '../../shared/local-workflow-rpc'
import type { LocalWorkflowFindStarted } from '../../shared/local-workflow-find-request'
import { workflowPlacementSummary } from '../../shared/local-workflow-placement'
import type { LocalWorkflowView } from '../../shared/local-workflow-view'
import { workflowResultDocument } from '../../shared/workflow-graph-web'
import { workflowRunResult } from '../../shared/workflow-run-result'
import { isEvolveRunFlags, workflowRunEvolve } from './workflow-evolve'

type Flags = Map<string, string | boolean>

const MAX_FILE_BYTES = 1024 * 1024

/** Opens the file once, refuses anything but a regular file, and reads at most the limit + 1 byte. */
async function readFlagFile(flag: string, path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    if (!(await handle.stat()).isFile()) {
      throw new Error('it is not a regular file')
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) {
        break
      }
      length += bytesRead
    }
    if (length > MAX_FILE_BYTES) {
      throw new Error('it is larger than 1 MB')
    }
    return buffer.subarray(0, length).toString('utf8')
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'there is no such file'
        : error instanceof Error
          ? error.message
          : String(error)
    throw new RuntimeClientError(
      'invalid_argument',
      `--${flag}: could not read ${path}: ${reason}.`
    )
  } finally {
    await handle?.close()
  }
}

const FLAG_OF_FIELD: Record<string, string> = {
  host: 'host',
  forceHost: 'force-host',
  requestedBy: 'requested-by',
  requestedById: 'requested-by-id',
  request: 'request',
  focusFinding: 'focus-finding'
}

function refuseDepthUnlessDiscover(flags: Flags, template: string): void {
  const flag = ['depth', 'focus-finding'].find((name) => flags.has(name))
  if (flag && template !== 'discover') {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${flag} applies to --template discover only, not ${template}.`
    )
  }
}

/** The request the flags describe, checked here so a mistake is named before anything starts. */
export async function runRequestFromFlags(
  flags: Flags,
  cwd: string
): Promise<LocalWorkflowRunRequest> {
  const promptFile = text(flags, 'prompt-file')
  if (promptFile && text(flags, 'prompt')) {
    throw new RuntimeClientError('invalid_argument', 'Give --prompt or --prompt-file, not both.')
  }
  const specFile = text(flags, 'spec-file')
  let spec: unknown
  if (specFile) {
    try {
      spec = JSON.parse(await readFlagFile('spec-file', resolve(cwd, specFile)))
    } catch (error) {
      throw error instanceof RuntimeClientError
        ? error
        : new RuntimeClientError('invalid_argument', `--spec-file: ${specFile} is not JSON.`)
    }
  }
  const routes = text(flags, 'routes')
  const parsed = localWorkflowRunRequestSchema.safeParse({
    ...(text(flags, 'origin') ? { origin: text(flags, 'origin') } : {}),
    template: text(flags, 'template') ?? '',
    prompt: promptFile
      ? await readFlagFile('prompt-file', resolve(cwd, promptFile))
      : (text(flags, 'prompt') ?? ''),
    ...(routes
      ? {
          routes: routes
            .split(',')
            .map((route) => route.trim())
            .filter(Boolean)
        }
      : {}),
    // Always sent: a runtime from before placement rejects the field by name instead of
    // silently running a fleet request on itself.
    runsOn: text(flags, 'runs-on') ?? 'fleet',
    ...launchFlags(flags),
    ...(text(flags, 'models') ? { models: text(flags, 'models') } : {}),
    // Only when given: a runtime from before --depth refuses the key, so plain Discover still runs.
    ...(flags.has('depth') ? { depth: text(flags, 'depth') ?? '' } : {}),
    ...(flags.has('focus-finding') ? { focusFinding: text(flags, 'focus-finding') ?? '' } : {}),
    ...(flags.get('no-earlier-runs') === true ? { skipEarlierRuns: true } : {}),
    ...(spec !== undefined ? { spec } : {})
  })
  if (parsed.success && parsed.data.models) {
    // Named here, before anything opens: a mistyped step or model costs nothing.
    try {
      workflowModelsFlagPlan(parsed.data.models)
    } catch (error) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--models: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]!.path[0] ?? 'prompt')
    const showOther = flags.get('other') === true
    throw new RuntimeClientError(
      'invalid_argument',
      field === 'template'
        ? showOther
          ? `--template: choose one of ${LOCAL_WORKFLOW_RUN_TEMPLATES.join(', ')}.`
          : `--template: choose one of ${LOCAL_WORKFLOW_RUN_TEMPLATES.join(', ')} (primary: discover, evolve; pass --other for the rest).`
        : field === 'prompt'
          ? 'Say what to run it on: --prompt "<request>" or --prompt-file <file>.'
          : field === 'spec'
            ? '--spec-file: the override must be a JSON object.'
            : field === 'runsOn'
              ? '--runs-on: choose fleet (the default) or local.'
              : field === 'depth'
                ? '--depth: choose quick or thorough (the default).'
                : `--${FLAG_OF_FIELD[field] ?? field}: ${parsed.error.issues[0]!.message}`
    )
  }
  refuseDepthUnlessDiscover(flags, parsed.data.template)
  return parsed.data
}

/** A completed run that lost calls says so; the Gaps list names each one. */
export function workflowRunDegradedLine(
  template: string,
  degraded: { lostCalls: number; steps: string[] }
): string {
  const calls = degraded.lostCalls === 1 ? '1 call' : `${degraded.lostCalls} calls`
  return `The ${template} workflow completed degraded: it lost ${calls} (${degraded.steps.join(', ')}) that no other account or model family could take.`
}

/** One line on where the run stands, for the terminal while it runs. */
export function workflowRunFollowLine(view: LocalWorkflowView): string {
  if (view.state === 'paused' || view.state === 'pausing') {
    return 'Paused in the app; following until it is resumed or stopped.'
  }
  const done = view.calls.filter((call) => call.state === 'completed').length
  return `${view.phase ?? (view.state === 'running' ? 'Running' : `Run ${view.state}`)} (${done} of ${view.calls.length} calls done)`
}

/** Registered with find-best's group (handlers/find-best.ts), which shares its start and follow. */
/** The run's frozen placement and who asked, read back once it started; older hosts have none. */
async function startedRun(
  ctx: Parameters<CommandHandler>[0],
  started: LocalWorkflowFindStarted
): Promise<LocalWorkflowFindStarted & Partial<LocalWorkflowRunStatus>> {
  try {
    const status = (
      await ctx.client.call<LocalWorkflowRunStatus>(LOCAL_WORKFLOW_METHODS.runStatus, {
        executionId: started.executionId
      })
    ).result
    return {
      ...started,
      state: status.state,
      ...(status.placement ? { placement: status.placement } : {}),
      ...(status.requestedBy ? { requestedBy: status.requestedBy } : {}),
      ...(status.requestedById ? { requestedById: status.requestedById } : {}),
      ...(status.request ? { request: status.request } : {})
    }
  } catch {
    return started
  }
}

export const workflowRun: CommandHandler = async (ctx) => {
  if (ctx.flags.has('requested-by-id')) {
    launchFlags(ctx.flags)
  }
  // Evolve runs jev-lab's CLI on a fleet host through its own service, not as a graph.
  if (isEvolveRunFlags(ctx.flags)) {
    refuseDepthUnlessDiscover(ctx.flags, 'evolve')
    return await workflowRunEvolve(ctx)
  }
  const request = await runRequestFromFlags(ctx.flags, ctx.cwd)
  const began = Date.now()
  let started: LocalWorkflowFindStarted
  try {
    started = await startLocalWorkflowFromCli(ctx, LOCAL_WORKFLOW_METHODS.run, request)
  } catch (error) {
    // Only the host's own answer proves nothing was admitted; a timeout or a bad flag is not that.
    if (!ctx.json || !(error instanceof RuntimeClientError) || error.code !== 'runtime_error') {
      throw error
    }
    // A refused Start is reported in the same document a started one would be.
    console.log(
      JSON.stringify(
        {
          started: false,
          template: request.template,
          reason: error instanceof Error ? error.message : String(error)
        },
        null,
        2
      )
    )
    process.exitCode = 1
    return
  }
  const run = await startedRun(ctx, started)
  if (ctx.flags.get('no-follow') === true) {
    console.log(
      ctx.json
        ? JSON.stringify({ started: true, ...run }, null, 2)
        : [
            `The ${request.template} workflow started in the app (run ${started.executionId}).`,
            ...(run.placement ? [`Placed on ${workflowPlacementSummary(run.placement)}.`] : [])
          ].join('\n')
    )
    return
  }
  if (!ctx.json && run.placement) {
    process.stderr.write(`Placed on ${workflowPlacementSummary(run.placement)}.\n`)
  }
  if (!ctx.json) {
    process.stderr.write(
      `The ${request.template} workflow is running in the app; Ctrl-C stops following it, not the run.\n`
    )
  }
  const view = await followLocalWorkflow(ctx, started, workflowRunFollowLine)
  const result = workflowRunResult(view, started, request.template, Date.now() - began)
  if (ctx.json) {
    // One document either way: a failed run is reported in it, with a nonzero exit and no second error document.
    console.log(JSON.stringify(result, null, 2))
    if (view.state !== 'completed') {
      process.exitCode = 1
    }
    return
  }
  if (result.markdown) {
    const gaps = result.gaps.map((gap) => `- ${gap}`)
    console.log(
      [
        workflowResultDocument({ markdown: result.markdown, appendix: result.appendix }).trim(),
        ...(gaps.length ? [['Gaps:', ...gaps].join('\n')] : [])
      ].join('\n\n')
    )
  }
  if (view.state === 'completed' && result.degraded) {
    process.stderr.write(`${workflowRunDegradedLine(request.template, result.degraded)}\n`)
  }
  if (view.state !== 'completed') {
    throw new RuntimeClientError(
      'workflow_failed',
      view.error ?? `The ${request.template} workflow ended ${view.state}.`
    )
  }
}
