import { SESSION_MANAGE_RPC } from '../../shared/session-manage-types'
import type { SessionTransferResult } from '../../shared/session-transfer-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { parseHostFlag, resolveHostFlagTarget } from '../execution-host-flag'
import { explicitTarget, refuseRemote } from './session-manage-access'
import { sessionProvenance } from './session-provenance-flags'

/**
 * `--host ssh:<id>` hands the work to a new session on that computer. Checked before the client is
 * touched: a paired host (`runtime:`) already rerouted the client, and is refused here instead.
 */
type HostMove = { host?: string; workspace?: string }

function hostMoveFlags(flags: HandlerContext['flags'], into: string): HostMove {
  const workspace = getOptionalStringFlag(flags, 'workspace')
  const host = parseHostFlag(flags)
  if (!host) {
    if (workspace !== undefined) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--workspace names the workspace on another computer; pass --host ssh:<id> too.'
      )
    }
    return {}
  }
  if (host.kind === 'runtime') {
    throw new RuntimeClientError(
      'unsupported',
      'Moving work to a paired OmniConsole (runtime:<id>) is not supported yet: this computer cannot verify a session there accepted it. Use an SSH host from omni host list. Nothing was changed.'
    )
  }
  if (host.kind === 'local') {
    throw new RuntimeClientError('invalid_argument', '--host local is this computer; omit --host.')
  }
  if (into !== 'new') {
    throw new RuntimeClientError(
      'invalid_argument',
      '--host starts a new session on that computer; use new as the target.'
    )
  }
  return { host: host.id, ...(workspace !== undefined ? { workspace } : {}) }
}

/** The exact SSH identity the connected runtime registers, for a label or id the caller passed. */
async function resolvedHost(context: HandlerContext, params: HostMove): Promise<HostMove> {
  if (params.host === undefined) {
    return params
  }
  const host = await resolveHostFlagTarget(context.flags, context.client)
  return { ...params, host: host?.id ?? params.host }
}

async function transfer(
  { client, flags, json }: HandlerContext,
  method: string,
  params: Record<string, unknown>,
  sources: number
): Promise<void> {
  const response = await client
    .call<SessionTransferResult>(
      method,
      { ...params, ...sessionProvenance(flags) },
      // This is an idle budget: the transfer's runtime keepalives refresh it while steps wait.
      // A move adds a push question per source and a longer acceptance on the other computer.
      {
        timeoutMs:
          (sources + 1) * 300_000 + 120_000 + ('host' in params ? (sources + 1) * 300_000 : 0)
      }
    )
    .catch((error: unknown) => {
      if (
        flags.get('dry-run') === true ||
        !(error instanceof RuntimeClientError) ||
        !['runtime_timeout', 'runtime_unavailable', 'invalid_runtime_response'].includes(error.code)
      ) {
        throw 'host' in params ? olderRuntimeRefusal(error) : error
      }
      throw new RuntimeClientError(
        error.code,
        `${error.message} Transfer outcome is unknown: a target, delivered brief or archive may already exist. Inspect the named sessions and action log before retrying.`,
        { outcome: 'unknown', method, request: params, cause: error.data }
      )
    })
  printResult(response, json, (result) =>
    [
      result.summary,
      ...(result.host?.verdict === 'unverifiable'
        ? [`${result.host.label} is unverifiable: nothing there was confirmed.`]
        : []),
      ...(result.dryRun ? result.steps.map((step, index) => `${index + 1}. ${step}`) : []),
      result.auditError ? `warning: ${result.auditError}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  )
  if (response.result.outcome === 'failed') {
    process.exitCode = 1
  }
}

/** An older runtime's strict schema names the unknown field; say what that means. */
function olderRuntimeRefusal(error: unknown): unknown {
  return error instanceof RuntimeClientError &&
    error.code === 'invalid_argument' &&
    /unrecognized key/i.test(error.message)
    ? new RuntimeClientError(
        'incompatible_runtime',
        'This OmniConsole predates moving work to another computer (--host). Update OmniConsole on this computer and try again. Nothing was changed.'
      )
    : error
}

export const SESSION_TRANSFER_HANDLERS: Record<string, CommandHandler> = {
  'session handoff': async (context) => {
    const to = getRequiredStringFlag(context.flags, 'to')
    const move = hostMoveFlags(context.flags, to)
    refuseRemote(context.client)
    const note = getOptionalStringFlag(context.flags, 'note')
    const target = await explicitTarget(context.client, context.flags)
    await transfer(
      context,
      SESSION_MANAGE_RPC.handoff,
      {
        target,
        to,
        ...(note !== undefined ? { note } : {}),
        ...(await resolvedHost(context, move))
      },
      1
    )
  },
  'session consolidate': async (context) => {
    const move = hostMoveFlags(context.flags, getRequiredStringFlag(context.flags, 'into'))
    refuseRemote(context.client)
    const panes = getRequiredStringFlag(context.flags, 'panes')
      .split(',')
      .map((pane) => pane.trim())
    if (
      panes.length < 2 ||
      panes.length > 50 ||
      panes.some((pane) => !pane) ||
      new Set(panes).size !== panes.length
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--panes requires 2–50 distinct, nonempty pane keys separated by commas.'
      )
    }
    const into = getRequiredStringFlag(context.flags, 'into')
    await transfer(
      context,
      SESSION_MANAGE_RPC.consolidate,
      {
        panes,
        into,
        ...(context.flags.get('skip-busy') === true ? { skipBusy: true } : {}),
        ...(await resolvedHost(context, move))
      },
      panes.length
    )
  }
}
