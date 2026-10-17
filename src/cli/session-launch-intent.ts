/**
 * Makes re-running an identical `omni session launch` the retry: the intent maps the raw inputs to
 * the operation they last started (the claim in session-launch-claim.ts stops two identical
 * invocations planning at once). See docs/reference/agent-launch.md.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { writeDurableSecureJsonFile } from '../shared/secure-file'
import { getOptionalStringFlag } from './flags'
import { launchFlagsAsTyped } from './launch-host-name'
import { RuntimeClientError } from './runtime/types'
import {
  LAUNCH_INTENTS_DIR_NAME,
  type AgentLaunchRecord,
  type AgentLaunchRecordStore
} from './session-launch-record'
import { replacedLaunchRefusal } from './session-launch-refusals'

export type LaunchIntentInputs = {
  host: string | null
  environment: string | null
  pairing: boolean
  worktree: string | null
  /** The cwd only when the workspace is derived from it (omitted, active or current). */
  cwd: string | null
  provider: string
  model: string | null
  effort: string | null
  prompt: string
  agentArgs: string | null
  managedToolsFile?: string | null
  agentTemplate: string | null
  folder: string | null
  /** --project as typed; null keeps a launch without it on the exact key PR 1 wrote. */
  project?: string | null
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Title and title-origin are deliberately absent: a retitle is not a new launch. */
export function launchIntentKey(inputs: LaunchIntentInputs): string {
  return sha256Hex(
    JSON.stringify([
      'v1',
      inputs.host,
      inputs.environment,
      inputs.pairing,
      inputs.worktree,
      inputs.cwd,
      inputs.provider,
      inputs.model,
      inputs.effort,
      sha256Hex(inputs.prompt),
      inputs.agentArgs,
      inputs.agentTemplate,
      inputs.folder,
      ...(inputs.project ? [{ project: inputs.project }] : []),
      ...(inputs.managedToolsFile ? [{ managedToolsFile: inputs.managedToolsFile }] : [])
    ])
  )
}

/** --host is read as typed (launchFlagsAsTyped), never as this run's route for it. */
export function launchIntentInputs(
  invocationFlags: Map<string, string | boolean>,
  cwd: string,
  prompt: string,
  env: NodeJS.ProcessEnv = process.env
): LaunchIntentInputs {
  const flags = launchFlagsAsTyped(invocationFlags)
  const project = getOptionalStringFlag(flags, 'project') ?? null
  const worktree = getOptionalStringFlag(flags, 'worktree') ?? null
  // Why: placement never reads the cwd, so a retry from another directory is the same launch.
  const cwdDerived =
    project === null && (worktree === null || worktree === 'active' || worktree === 'current')
  const host = getOptionalStringFlag(flags, 'host') ?? null
  // Why: placement reaches every computer with null selectors, so ambient ones never change it.
  const placed = project !== null
  return {
    // Why: with --project, `--host auto` is only a synonym for omitting --host.
    host: placed && host?.trim().toLowerCase() === 'auto' ? null : host,
    environment: placed
      ? null
      : (getOptionalStringFlag(flags, 'environment') ?? env.ORCA_ENVIRONMENT ?? null),
    pairing:
      !placed &&
      Boolean(
        getOptionalStringFlag(flags, 'pairing-code') ??
        env.ORCA_PAIRING_CODE ??
        env.ORCA_REMOTE_PAIRING
      ),
    worktree,
    cwd: cwdDerived ? resolve(cwd) : null,
    provider: getOptionalStringFlag(flags, 'provider') ?? '',
    model: getOptionalStringFlag(flags, 'model') ?? null,
    effort: getOptionalStringFlag(flags, 'effort') ?? null,
    prompt,
    agentArgs: getOptionalStringFlag(flags, 'agent-args') ?? null,
    managedToolsFile: getOptionalStringFlag(flags, 'managed-tools-file') ?? null,
    agentTemplate: getOptionalStringFlag(flags, 'agent-template') ?? null,
    folder: getOptionalStringFlag(flags, 'folder') ?? null,
    project
  }
}

function intentPath(store: AgentLaunchRecordStore, intentKey: string, suffix: string): string {
  return join(store.dir, LAUNCH_INTENTS_DIR_NAME, `${intentKey}${suffix}`)
}

export function readLaunchIntent(store: AgentLaunchRecordStore, intentKey: string): string | null {
  try {
    const intent = JSON.parse(readFileSync(intentPath(store, intentKey, '.json'), 'utf8')) as {
      operationId?: unknown
    }
    return typeof intent.operationId === 'string' ? intent.operationId : null
  } catch {
    return null
  }
}

export function writeLaunchIntent(
  store: AgentLaunchRecordStore,
  intentKey: string,
  operationId: string,
  now = Date.now()
): void {
  writeDurableSecureJsonFile(intentPath(store, intentKey, '.json'), { operationId, updatedAt: now })
}

export type LaunchOperationChoice =
  | { kind: 'mint'; expectedRuntimeId?: string }
  | { kind: 'explicit'; operationId: string; runtimeId: string }
  | { kind: 'follow'; record: AgentLaunchRecord }
  | { kind: 'already-launched'; record: AgentLaunchRecord }

function differentLaunchRefusal(operationId: string): RuntimeClientError {
  return new RuntimeClientError(
    'invalid_argument',
    `Operation ${operationId} was recorded for a different launch (another computer, workspace or brief). Run the original command again, or omit --operation-id.`,
    {
      operationId,
      outcome: 'not-sent',
      nextSteps: ['Omit --operation-id and --controller-runtime-id.']
    }
  )
}

type ReadLaunchRecord = (operationId: string) => AgentLaunchRecord | null

/**
 * A superseded operation continues as the operation that replaced it; following the old one would
 * supersede it a second time and start a second session. A broken link refuses rather than mints.
 */
export function newestLaunchRecord(
  record: AgentLaunchRecord,
  read: ReadLaunchRecord
): AgentLaunchRecord {
  const seen = new Set([record.operationId])
  let current = record
  while (current.supersededBy) {
    const next = read(current.supersededBy)
    if (!next || seen.has(next.operationId) || next.intentKey !== record.intentKey) {
      throw replacedLaunchRefusal(current, 'lost')
    }
    seen.add(next.operationId)
    current = next
  }
  return current
}

function continueLaunchRecord(record: AgentLaunchRecord): LaunchOperationChoice {
  return record.outcome === 'created'
    ? { kind: 'already-launched', record }
    : { kind: 'follow', record }
}

/** Which operation this invocation continues: R5 (already launched), R10 and R11 decide here. */
export function chooseLaunchOperation(args: {
  intentKey: string
  again: boolean
  intentRecord: AgentLaunchRecord | null
  explicitOperationId?: string
  explicitRecord: AgentLaunchRecord | null
  explicitRuntimeId?: string
  /** Reads a superseding record; without it a superseded record refuses. */
  readRecord?: ReadLaunchRecord
}): LaunchOperationChoice {
  const readRecord = args.readRecord ?? (() => null)
  const { explicitOperationId: explicitId, explicitRuntimeId: runtimeId } = args
  if (explicitId && args.again) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--again starts a new operation, so it cannot reuse --operation-id. Omit one of them.'
    )
  }
  if (explicitId) {
    const record = args.explicitRecord
    if (!record) {
      if (!runtimeId) {
        throw new RuntimeClientError(
          'invalid_argument',
          `--operation-id ${explicitId} has no launch record on this computer. Pass the --controller-runtime-id you recorded with it, or omit both and omni records them.`,
          { operationId: explicitId, outcome: 'not-sent', nextSteps: [] }
        )
      }
      return { kind: 'explicit', operationId: explicitId, runtimeId }
    }
    if (
      record.intentKey !== args.intentKey ||
      (runtimeId && runtimeId !== record.executingRuntimeId)
    ) {
      throw differentLaunchRefusal(explicitId)
    }
    return continueLaunchRecord(newestLaunchRecord(record, readRecord))
  }
  if (args.again) {
    return { kind: 'mint', ...(runtimeId ? { expectedRuntimeId: runtimeId } : {}) }
  }
  const record = args.intentRecord
  if (!record) {
    return { kind: 'mint', ...(runtimeId ? { expectedRuntimeId: runtimeId } : {}) }
  }
  if (runtimeId && runtimeId !== record.executingRuntimeId) {
    throw differentLaunchRefusal(record.operationId)
  }
  return continueLaunchRecord(newestLaunchRecord(record, readRecord))
}

/** Only an operation omni minted, whose every send provably started nothing, may be replaced. */
export function canSupersedeLaunch(record: AgentLaunchRecord): boolean {
  return record.minted && record.sends.every((send) => send.outcome === 'not-started')
}

/**
 * `resend` keeps the operation (the host ledger replays or relaunches it); `supersede` replaces it
 * after a restart; `unverifiable` means a maybe-started send met a restarted runtime (R3).
 */
export function resumeLaunchRecord(
  record: AgentLaunchRecord,
  runtimeId: string
): 'resend' | 'supersede' | 'unverifiable' {
  if (runtimeId === record.executingRuntimeId) {
    return 'resend'
  }
  return canSupersedeLaunch(record) ? 'supersede' : 'unverifiable'
}

/** A fresh operation for the same launch, linked both ways so either record names the other. */
export function supersedeLaunchRecord(
  old: AgentLaunchRecord,
  next: { operationId: string; runtimeId: string; now: number }
): { old: AgentLaunchRecord; next: AgentLaunchRecord } {
  const selection = old.request?.sshAccountSelection
  return {
    old: { ...old, supersededBy: next.operationId },
    next: {
      ...old,
      operationId: next.operationId,
      minted: true,
      createdAt: next.now,
      executingRuntimeId: next.runtimeId,
      request: old.request && {
        ...old.request,
        clientOperationId: next.operationId,
        ...(selection
          ? { sshAccountSelection: { ...selection, expectedRuntimeId: next.runtimeId } }
          : {})
      },
      post: { ...old.post, done: false },
      sends: [],
      outcome: 'pending',
      supersedes: old.operationId,
      supersededBy: undefined
    }
  }
}
