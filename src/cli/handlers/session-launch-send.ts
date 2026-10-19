import type { RuntimeCreateAgentSessionResult } from '../../shared/agent-session-host-authority'
import { AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeRpcSuccess } from '../../shared/runtime-rpc-envelope'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { withLaunchClaim } from '../session-launch-claim'
import {
  canSupersedeLaunch,
  chooseLaunchOperation,
  readLaunchIntent,
  resumeLaunchRecord,
  supersedeLaunchRecord,
  writeLaunchIntent
} from '../session-launch-intent'
import {
  appendLaunchSend,
  classifyLaunchSend,
  mintLaunchOperationId,
  pruneLaunchRecords,
  requireSendableLaunchRecord,
  settleLaunchSend,
  type AgentLaunchRecord,
  type AgentLaunchRecordStore,
  type SendableLaunchRecord,
  type SettledLaunchSend
} from '../session-launch-record'
import {
  incompatibleRuntimeRefusal,
  launchRetryPhrase,
  replacedLaunchRefusal
} from '../session-launch-refusals'
import type { LaunchInput } from './session-launch-input'
import { planSessionLaunch, type LaunchPlan } from './session-launch-plan'
import { launchRecoveryError, notStartedLaunchError } from './session-launch-receipt'
import {
  launchRouteName,
  readRecordedLaunchStatus,
  type LaunchHostStatus
} from './session-launch-target'

const CREATE_AGENT_SESSION_TIMEOUT_MS = 240_000

export type LaunchContext = Pick<HandlerContext, 'flags' | 'client' | 'cwd'> & {
  input: LaunchInput
  store: AgentLaunchRecordStore
  intentKey: string
}

export type SendingLaunch = { kind: 'send'; record: SendableLaunchRecord; sentAt: number }

export type PreparedLaunch = { kind: 'already-launched'; record: AgentLaunchRecord } | SendingLaunch

export type SentLaunch = {
  record: AgentLaunchRecord
  response: RuntimeRpcSuccess<RuntimeCreateAgentSessionResult>
  warnings: string[]
}

/** Steps 2–9 of the order of effects; the caller holds the claim. Nothing is sent here. */
export async function prepareLaunchOperation(ctx: LaunchContext): Promise<PreparedLaunch> {
  const { input, store, intentKey } = ctx
  const intentOperationId = readLaunchIntent(store, intentKey)
  const choice = chooseLaunchOperation({
    intentKey,
    again: input.again,
    intentRecord: intentOperationId ? store.read(intentOperationId) : null,
    explicitOperationId: input.operationId,
    explicitRecord: input.operationId ? store.read(input.operationId) : null,
    explicitRuntimeId: input.controllerRuntimeId,
    readRecord: (operationId) => store.read(operationId)
  })
  switch (choice.kind) {
    case 'already-launched':
      return { kind: 'already-launched', record: choice.record }
    case 'follow':
      return await followLaunchRecord(ctx, choice.record)
    case 'mint':
      return await recordNewLaunch(ctx, {
        minted: true,
        expectedRuntimeId: choice.expectedRuntimeId
      })
    case 'explicit':
      return await recordNewLaunch(ctx, {
        minted: false,
        operationId: choice.operationId,
        expectedRuntimeId: choice.runtimeId
      })
  }
}

export function launchRecordFromPlan(
  plan: LaunchPlan,
  args: { operationId: string; minted: boolean; intentKey: string; now: number; input: LaunchInput }
): SendableLaunchRecord {
  return {
    v: 1,
    operationId: args.operationId,
    minted: args.minted,
    intentKey: args.intentKey,
    createdAt: args.now,
    route: plan.route,
    executingRuntimeId: plan.status.runtimeId,
    hostId: plan.workspace.hostId,
    hostLabel: plan.host.name,
    request: { clientOperationId: args.operationId, ...plan.request },
    post: {
      ...(args.input.title ? { title: args.input.title } : {}),
      ...(args.input.titleOrigin ? { titleOrigin: args.input.titleOrigin } : {}),
      folderId: plan.folderId,
      ...(plan.project ? { projectItems: plan.project.items } : {}),
      ...(args.input.contract
        ? { contract: { ...args.input.contract, agent: args.input.provider } }
        : {}),
      ...(args.input.ephemeral ? { ephemeral: true } : {}),
      done: false
    },
    sends: [],
    outcome: 'pending',
    summary: {
      host: plan.host,
      workspace: plan.workspace,
      manifest: plan.manifest,
      ...(plan.project?.report ? { project: plan.project.report } : {}),
      warnings: plan.project?.warnings ?? []
    }
  }
}

async function recordNewLaunch(
  ctx: LaunchContext,
  args: { minted: boolean; operationId?: string; expectedRuntimeId?: string }
): Promise<PreparedLaunch> {
  const plan = await planSessionLaunch(ctx, ctx.input, {
    preview: false,
    ...(args.expectedRuntimeId ? { expectedRuntimeId: args.expectedRuntimeId } : {})
  })
  const now = Date.now()
  const operationId = args.operationId ?? mintLaunchOperationId(now)
  const record = launchRecordFromPlan(plan, {
    ...args,
    operationId,
    intentKey: ctx.intentKey,
    now,
    input: ctx.input
  })
  ctx.store.write(record)
  writeLaunchIntent(ctx.store, ctx.intentKey, operationId, now)
  try {
    pruneLaunchRecords(ctx.store, now)
  } catch {
    // Pruning is housekeeping; a failure must not block a recorded launch.
  }
  return beginLaunchSend(ctx.store, record)
}

/** Appends the send durably before it happens, so a killed CLI leaves an unverifiable send. */
export function beginLaunchSend(
  store: AgentLaunchRecordStore,
  record: SendableLaunchRecord
): SendingLaunch {
  const lastAt = record.sends.at(-1)?.at ?? 0
  const sentAt = Math.max(Date.now(), lastAt + 1)
  const next = appendLaunchSend(record, sentAt)
  store.write(next)
  return { kind: 'send', record: next, sentAt }
}

export async function followLaunchRecord(
  ctx: LaunchContext,
  record: AgentLaunchRecord
): Promise<PreparedLaunch> {
  const status = await readRecordedLaunchStatus(ctx.flags, ctx.client, record)
  const resume = resumeLaunchRecord(record, status.runtimeId)
  switch (resume) {
    case 'resend':
      return beginLaunchSend(ctx.store, requireSendableLaunchRecord(record))
    case 'supersede':
      return supersedeLaunch(ctx, record, status)
    case 'unverifiable':
      throw launchRecoveryError('restarted', {
        record,
        flags: ctx.flags,
        runtimeId: status.runtimeId
      })
  }
}

/**
 * Runs under the claim and re-reads the record first: an identical run may already have
 * replaced or resent this operation, and replacing it again would start a second session.
 */
function supersedeLaunch(
  ctx: LaunchContext,
  seen: AgentLaunchRecord,
  status: LaunchHostStatus,
  refusedAs: 'restarted' | 'expired' = 'restarted'
): SendingLaunch {
  const old = ctx.store.read(seen.operationId) ?? seen
  if (old.supersededBy) {
    throw replacedLaunchRefusal(old, 'replaced', {
      retry: launchRetryPhrase(ctx.flags),
      code:
        refusedAs === 'restarted'
          ? 'agent_session_runtime_changed'
          : 'agent_session_operation_expired'
    })
  }
  if (!canSupersedeLaunch(old)) {
    throw launchRecoveryError(refusedAs, {
      record: old,
      flags: ctx.flags,
      runtimeId: status.runtimeId
    })
  }
  // Why: the replacement runtime may be older; never send it a 'local' it cannot verify.
  if (
    old.hostId === 'local' &&
    !status.capabilities.includes(AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY)
  ) {
    throw incompatibleRuntimeRefusal({
      name: launchRouteName(old.route),
      local: old.route.kind === 'local',
      appVersion: status.appVersion
    })
  }
  const now = Date.now()
  const replaced = supersedeLaunchRecord(old, {
    operationId: mintLaunchOperationId(now),
    runtimeId: status.runtimeId,
    now
  })
  ctx.store.write(replaced.next)
  ctx.store.write(replaced.old)
  writeLaunchIntent(ctx.store, ctx.intentKey, replaced.next.operationId, now)
  return beginLaunchSend(ctx.store, requireSendableLaunchRecord(replaced.next))
}

/** Re-reads under the claim so a concurrent identical run's appended send is kept. */
async function recordSendOutcome(
  ctx: LaunchContext,
  prepared: SendingLaunch,
  settled: SettledLaunchSend,
  result?: RuntimeCreateAgentSessionResult
): Promise<{ record: AgentLaunchRecord; warning?: string }> {
  const update = async (): Promise<AgentLaunchRecord> => {
    const current = ctx.store.read(prepared.record.operationId) ?? prepared.record
    const next = settleLaunchSend(current, prepared.sentAt, settled, result)
    ctx.store.write(next)
    return next
  }
  try {
    return { record: await withLaunchClaim(ctx.store, ctx.intentKey, update) }
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'launch_busy') {
      return { record: await update() }
    }
    return {
      record: settleLaunchSend(prepared.record, prepared.sentAt, settled, result),
      warning: `The launch record was not updated (${error instanceof Error ? error.message : String(error)}); a re-run still reuses operation ${prepared.record.operationId}.`
    }
  }
}

function announceLaunchSend(record: AgentLaunchRecord, flags: Map<string, string | boolean>): void {
  process.stderr.write(
    `omni session launch: operation ${record.operationId} on ${record.hostLabel}. If this command is interrupted, run ${launchRetryPhrase(flags)}; it reuses this operation.\n`
  )
}

/** Steps 11–13: announce, send the recorded bytes, and record what the host answered. */
export async function sendLaunch(
  ctx: LaunchContext,
  prepared: SendingLaunch,
  superseded = false
): Promise<SentLaunch> {
  announceLaunchSend(prepared.record, ctx.flags)
  let response: RuntimeRpcSuccess<RuntimeCreateAgentSessionResult>
  try {
    response = await ctx.client.call<RuntimeCreateAgentSessionResult>(
      'terminal.createAgentSession',
      prepared.record.request,
      { timeoutMs: CREATE_AGENT_SESSION_TIMEOUT_MS }
    )
  } catch (error) {
    const settled = classifyLaunchSend(error)
    const { record } = await recordSendOutcome(ctx, prepared, settled)
    if (settled.outcome === 'unverifiable') {
      throw launchRecoveryError('unknown', { record, flags: ctx.flags, cause: settled })
    }
    if (
      settled.code === 'agent_session_runtime_changed' ||
      settled.code === 'agent_session_operation_expired'
    ) {
      const refusedAs = settled.code === 'agent_session_runtime_changed' ? 'restarted' : 'expired'
      if (!superseded && canSupersedeLaunch(record)) {
        const next = await withLaunchClaim(ctx.store, ctx.intentKey, async () =>
          supersedeLaunch(
            ctx,
            record,
            await readRecordedLaunchStatus(ctx.flags, ctx.client, record),
            refusedAs
          )
        )
        return await sendLaunch(ctx, next, true)
      }
      const runtimeId = (error as { data?: { runtimeId?: unknown } }).data?.runtimeId
      throw launchRecoveryError(refusedAs, {
        record,
        flags: ctx.flags,
        ...(typeof runtimeId === 'string' ? { runtimeId } : {})
      })
    }
    throw notStartedLaunchError(error, record, ctx.flags)
  }
  const { record, warning } = await recordSendOutcome(
    ctx,
    prepared,
    { outcome: response.result.disposition },
    response.result
  )
  return { record, response, warnings: warning ? [warning] : [] }
}
