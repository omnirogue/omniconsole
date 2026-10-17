/**
 * The fresh worktree a --project launch runs in: created once with the host's idempotent
 * `worktree.create`, journaled before the send and as soon as it answers (spec §3.5).
 */

import {
  launchWorktreeClientMutationId,
  type LaunchPlacement
} from '../shared/agent-launch-placement-types'
import { WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../shared/protocol-version'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../shared/remote-runtime-client-error-classification'
import type { RuntimeStatus, RuntimeWorktreeCreateResult } from '../shared/runtime-types'
import { slugifyForWorkspaceName } from '../shared/workspace-name'
import {
  worktreeCreateFailedRefusal,
  worktreeCreateUnverifiableRefusal
} from './launch-placement-refusals'
import type { RuntimeClient } from './runtime-client'
import { RuntimeRpcFailureError } from './runtime/types'
import type { AgentLaunchRecord, AgentLaunchRecordStore } from './session-launch-record'
import { hostUnreachableRefusal, launchRefusal } from './session-launch-refusals'

/** The host keeps a finished create's answer this long (WORKTREE_CREATE_RESULT_TTL_MS). */
export const LAUNCH_WORKTREE_CREATE_TTL_MS = 60_000
// Why: the host's window starts once the first create finishes, never at a resend, and a resend
// still has to connect and travel; this much of it is left unused.
const CREATE_RESEND_MARGIN_MS = 15_000
const STATUS_TIMEOUT_MS = 10_000
const WORKTREE_CREATE_TIMEOUT_MS = 120_000

/** --name, else a slug of --title, else of the brief's first line; the caller adds the op suffix. */
export function launchWorktreeNameBase(input: {
  worktreeName?: string
  title?: string
  prompt: string
}): string {
  const firstLine = input.prompt.split(/\r?\n/).find((line) => line.trim()) ?? ''
  return slugifyForWorkspaceName(input.worktreeName ?? input.title ?? firstLine)
    .slice(0, 40)
    .replace(/[-._]+$/g, '')
}

/** The operation id's last 6 characters keep each launch's worktree name distinct. */
export function launchWorktreeName(base: string, operationId: string): string {
  return `${base || 'launch'}-${operationId.slice(-6)}`
}

type PlacedRecord = AgentLaunchRecord & { placement: LaunchPlacement }

function withPlacement(record: PlacedRecord, placement: LaunchPlacement): PlacedRecord {
  return { ...record, placement }
}

async function readCreateStatus(client: RuntimeClient): Promise<RuntimeStatus> {
  return (
    await client.call<RuntimeStatus>('status.get', undefined, { timeoutMs: STATUS_TIMEOUT_MS })
  ).result
}

/**
 * Only the host's own error answer proves it handled the create and dropped it from its dedupe;
 * a reply this computer could not read (a bad frame, a mismatched id) may follow a real create.
 */
function isAnsweredFailure(error: unknown): error is RuntimeRpcFailureError {
  return (
    error instanceof RuntimeRpcFailureError &&
    !isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
  )
}

/** Whole seconds left to resend the first create inside the host's dedupe window, never below 0. */
function resendSecondsLeft(sentAt: number, ttlMs: number, now: number): number {
  return Math.max(0, Math.floor((ttlMs - CREATE_RESEND_MARGIN_MS - (now - sentAt)) / 1000))
}

/**
 * The created worktree's id, creating it at most once: a resend inside the host's dedupe window,
 * measured from the first send, reuses the same create; after it, or a host restart, it refuses.
 */
export async function ensurePlacementWorktree(args: {
  store: AgentLaunchRecordStore
  record: PlacedRecord
  client: RuntimeClient
  now: () => number
}): Promise<{ record: PlacedRecord; worktreeId: string }> {
  const { store, record, client } = args
  const { placement } = record
  if (placement.createdWorktreeId) {
    return { record, worktreeId: placement.createdWorktreeId }
  }
  const { chosen, workspacePlan } = placement
  const sentAt = placement.worktreeCreateSentAt
  let status: RuntimeStatus
  try {
    status = await readCreateStatus(client)
  } catch (error) {
    if (sentAt === undefined) {
      throw hostUnreachableRefusal(chosen.label, STATUS_TIMEOUT_MS / 1000, error)
    }
    // Why: the earlier create may have made the worktree, so this is no "Nothing was sent".
    throw worktreeCreateUnverifiableRefusal(
      record,
      placement,
      `${chosen.label} could not be reached within ${STATUS_TIMEOUT_MS / 1000} s to confirm its earlier create`,
      resendSecondsLeft(sentAt, LAUNCH_WORKTREE_CREATE_TTL_MS, args.now())
    )
  }
  if (sentAt !== undefined && placement.worktreeCreateRuntimeId !== status.runtimeId) {
    throw worktreeCreateUnverifiableRefusal(
      record,
      placement,
      `OmniConsole on ${chosen.label} restarted after the create was sent, so it no longer remembers it`
    )
  }
  if (!(status.capabilities ?? []).includes(WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY)) {
    throw launchRefusal(
      'incompatible_runtime',
      `${chosen.label} no longer advertises ${WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY}, so its launch worktree cannot be created safely. Nothing was sent.`,
      { operationId: record.operationId, outcome: 'not-sent', nextSteps: [] }
    )
  }
  const ttlMs = Math.min(
    LAUNCH_WORKTREE_CREATE_TTL_MS,
    status.worktreeCreateIdempotency?.dedupeTtlMs ?? LAUNCH_WORKTREE_CREATE_TTL_MS
  )
  if (sentAt !== undefined && resendSecondsLeft(sentAt, ttlMs, args.now()) <= 0) {
    throw worktreeCreateUnverifiableRefusal(
      record,
      placement,
      `its create was sent ${Math.round((args.now() - sentAt) / 1000)} s ago and its answer was never recorded; a resend now could reach the host after its ${ttlMs / 1000} s dedupe window and make a second worktree`
    )
  }
  // Why: journaled once, before the first send, so a killed CLI leaves a create a re-run can judge;
  // a resend keeps that time, since the host's window never moves for a resend.
  const firstSentAt = sentAt ?? args.now()
  const journaled =
    sentAt === undefined
      ? withPlacement(record, {
          ...placement,
          worktreeCreateSentAt: firstSentAt,
          worktreeCreateRuntimeId: status.runtimeId
        })
      : record
  if (sentAt === undefined) {
    store.write(journaled)
  }
  const callerTerminalHandle = process.env.ORCA_TERMINAL_HANDLE || undefined
  let created: RuntimeWorktreeCreateResult
  try {
    created = (
      await client.call<RuntimeWorktreeCreateResult>(
        'worktree.create',
        {
          repo: workspacePlan.repoSelector,
          name: workspacePlan.name,
          noParent: true,
          // Why 'run' without runHooks: setup runs beside the agent as `--setup run` does, an
          // 'ask' repo cannot refuse after `git worktree add`, and nothing is revealed or focused.
          runHooks: false,
          setupDecision: 'run',
          clientMutationId: launchWorktreeClientMutationId(record.operationId),
          cliProvenanceRequest: callerTerminalHandle ? { callerTerminalHandle } : {}
        },
        { timeoutMs: WORKTREE_CREATE_TIMEOUT_MS }
      )
    ).result
  } catch (error) {
    if (!isAnsweredFailure(error)) {
      throw worktreeCreateUnverifiableRefusal(
        journaled,
        journaled.placement,
        `${chosen.label} did not confirm the create`,
        resendSecondsLeft(firstSentAt, ttlMs, args.now())
      )
    }
    // Why: the host drops a failed create from its dedupe record, so a re-run starts it afresh.
    const {
      worktreeCreateSentAt: _sent,
      worktreeCreateRuntimeId: _runtime,
      ...cleared
    } = journaled.placement
    store.write(withPlacement(journaled, cleared))
    throw worktreeCreateFailedRefusal(journaled, journaled.placement, error)
  }
  const worktreeId = created.worktree.id
  const done = withPlacement(journaled, {
    ...journaled.placement,
    createdWorktreeId: worktreeId,
    ...(created.warning ? { createdWorktreeWarning: created.warning } : {})
  })
  store.write(done)
  return { record: done, worktreeId }
}
