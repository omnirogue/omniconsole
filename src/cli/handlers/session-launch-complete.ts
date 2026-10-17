import type { AgentLaunchEffectiveModel } from '../../shared/agent-launch-account'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { launchPlacementReceiptLines } from '../launch-placement-format'
import type { AgentLaunchRecord } from '../session-launch-record'
import { fileNewTerminal } from './session-folders'
import { bindProjectLaunch } from './session-launch-project'
import {
  formatLaunchReceipt,
  launchRetryCommand,
  type LaunchReceiptResult
} from './session-launch-receipt'
import { sendLaunch, type LaunchContext, type PreparedLaunch } from './session-launch-send'

/** Title, filing and project binding run once per operation, also after an interrupted run. */
async function finishLaunchPostSteps(
  ctx: LaunchContext,
  record: AgentLaunchRecord
): Promise<string[]> {
  const terminal = record.terminal
  if (record.post.done || !terminal) {
    return []
  }
  const { client } = ctx
  const warnings: string[] = []
  const title = ctx.input.title ?? record.post.title
  const titleOrigin = ctx.input.titleOrigin ?? record.post.titleOrigin
  if (title) {
    try {
      await client.call('terminal.rename', {
        terminal: terminal.handle,
        title,
        ...(titleOrigin ? { titleOrigin } : {}),
        titleSource: 'session-launch'
      })
    } catch {
      warnings.push(
        'The terminal was created, but its title was not confirmed. Reconcile this terminal before retrying.'
      )
    }
  }
  if (record.post.folderId) {
    try {
      await fileNewTerminal(client, terminal, record.post.folderId, 'session-launch')
    } catch {
      warnings.push(
        'The terminal was created, but its folder was not confirmed. File this terminal; do not launch another.'
      )
    }
  }
  const unbound = record.post.projectItems
    ? await bindProjectLaunch(client, terminal.handle, record.post.projectItems)
    : null
  if (unbound) {
    warnings.push(unbound)
  }
  // A lost answer keeps the post steps open, so re-running the same command binds it then.
  const bound = record.post.contract ? await bindContract(ctx, record, warnings) : true
  if (bound) {
    try {
      ctx.store.write({ ...record, post: { ...record.post, done: true } })
    } catch {
      // The steps ran; a lost marker only means a later re-run repeats these idempotent steps.
    }
  }
  return warnings
}

// The host waits for the session's first turn before it binds, so allow it the same few minutes.
const CONTRACT_BIND_TIMEOUT_MS = 240_000

/** False when the answer was lost, so the binding is retried by running the same command again. */
async function bindContract(
  ctx: LaunchContext,
  record: AgentLaunchRecord,
  warnings: string[]
): Promise<boolean> {
  try {
    const answer = await ctx.client.call<{
      attached?: unknown
      reason?: string
      retryable?: boolean
    }>(
      'agentSession.attachContractVerify',
      { terminal: record.terminal!.handle, ...record.post.contract },
      { timeoutMs: CONTRACT_BIND_TIMEOUT_MS }
    )
    if (answer.result.attached === true) {
      return true
    }
    // Only a definite refusal is final; anything else is unconfirmed and stays retryable.
    const final = answer.result.attached === false && !answer.result.retryable
    warnings.push(
      final
        ? `The session was launched, but its Acceptance lines were not bound to a verify step: ${answer.result.reason ?? 'no reason given'}. Add Verify from Up next; do not launch another.`
        : `The session was launched, but binding its Acceptance lines to a verify step was not confirmed${answer.result.reason ? ` (${answer.result.reason})` : ''}. Run the same command again to retry the binding; it will not launch another session.`
    )
    return final
  } catch (error) {
    const old = error instanceof RuntimeClientError && error.code === 'method_not_found'
    warnings.push(
      old
        ? 'The session was launched, but that OmniConsole predates contract verification, so its Acceptance lines were not bound to a verify step. Add Verify from Up next; do not launch another.'
        : 'The session was launched, but binding its Acceptance lines to a verify step was not confirmed. Run the same command again to retry the binding; it will not launch another session.'
    )
    return old
  }
}

// Why: an older host reports no effective model; the request still says what was asked for.
function requestedLaunchModel(record: AgentLaunchRecord): AgentLaunchEffectiveModel | null {
  const preferences = record.request?.launchPreferences
  return preferences?.model || preferences?.effort
    ? { model: preferences.model ?? null, effort: preferences.effort ?? null, source: 'request' }
    : null
}

function launchReceipt(
  ctx: LaunchContext,
  record: AgentLaunchRecord,
  disposition: LaunchReceiptResult['disposition'],
  warnings: string[]
): LaunchReceiptResult {
  const created = record.sends.find(
    (send) => send.outcome === 'created' || send.outcome === 'replayed'
  )
  return {
    terminal: record.terminal!,
    disposition,
    operationId: record.operationId,
    host: record.summary.host,
    workspace: record.summary.workspace,
    account: record.account ?? null,
    launch: record.launch ?? requestedLaunchModel(record),
    ...(record.routing ? { routing: record.routing } : {}),
    record: ctx.store.pathOf(record.operationId),
    retryCommand: launchRetryCommand(ctx.flags),
    warnings,
    manifest: record.summary.manifest,
    ...(record.summary.project ? { project: record.summary.project } : {}),
    ...(record.placement ? { placement: record.placement } : {}),
    ...(disposition === 'already-launched' && created ? { launchedAt: created.at } : {})
  }
}

function printLaunchReceipt(
  ctx: LaunchContext,
  response: { id: string; _meta: { runtimeId: string } },
  receipt: LaunchReceiptResult,
  json: boolean
): void {
  printResult(
    { id: response.id, ok: true, result: receipt, _meta: response._meta },
    json,
    (value) =>
      [
        formatLaunchReceipt(value, ctx.input.provider, { again: ctx.input.again }),
        ...launchPlacementReceiptLines(value.placement)
      ].join('\n')
  )
}

/**
 * Steps 11–13 for a prepared operation: an already-launched record only finishes its post steps;
 * otherwise send, record, post steps and the receipt. `onSendError` may add context to a refusal.
 */
export async function completeLaunch(
  ctx: LaunchContext,
  prepared: PreparedLaunch,
  options: { json: boolean; onSendError?: (error: unknown) => unknown }
): Promise<void> {
  if (prepared.kind === 'already-launched') {
    const warnings = await finishLaunchPostSteps(ctx, prepared.record)
    const receipt = launchReceipt(ctx, prepared.record, 'already-launched', warnings)
    const meta = { runtimeId: prepared.record.executingRuntimeId }
    printLaunchReceipt(ctx, { id: 'local', _meta: meta }, receipt, options.json)
    return
  }
  let sent: Awaited<ReturnType<typeof sendLaunch>>
  try {
    sent = await sendLaunch(ctx, prepared)
  } catch (error) {
    throw options.onSendError ? options.onSendError(error) : error
  }
  const warnings = [
    ...(sent.record.terminal?.warning ? [sent.record.terminal.warning] : []),
    ...sent.record.summary.warnings,
    ...sent.warnings,
    ...(await finishLaunchPostSteps(ctx, sent.record))
  ]
  const receipt = launchReceipt(ctx, sent.record, sent.response.result.disposition, warnings)
  printLaunchReceipt(ctx, sent.response, receipt, options.json)
}
