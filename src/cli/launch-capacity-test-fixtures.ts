/**
 * Test fixtures for the launch candidate reader, the capacity view and placement: setups, receipts,
 * capacity rows, and a fake runtime that answers RPCs by method and records every call.
 */

import type {
  AgentLaunchAccountReceipt,
  AgentLaunchLoad,
  AgentLaunchReadinessResult
} from '../shared/agent-launch-account'
import type { LaunchPlacementProject } from '../shared/agent-launch-placement-types'
import { hostLoadBand } from '../shared/host-resource-model'
import type { ProjectHostSetup } from '../shared/project-types'
import {
  AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY,
  WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY
} from '../shared/protocol-version'
import type { AccountCapacityRow } from '../shared/provider-account-capacity'
import type { LaunchRpcClient } from './launch-candidate-reader'

export const NOW = 1_800_000_000_000

export const NEW_RUNTIME_CAPABILITIES = [
  AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY,
  WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY
]
export const OLD_RUNTIME_CAPABILITIES = [WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY]

export const OMNI_IDE: LaunchPlacementProject = {
  input: 'omni-ide',
  identityKey: 'github:omnirogue/omni-ide',
  name: 'omni-ide'
}

export function projectSetup(change: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: 'setup-1',
    projectId: OMNI_IDE.identityKey,
    hostId: 'local',
    repoId: 'repo-1',
    path: '/w/omni-ide',
    displayName: 'omni-ide',
    kind: 'git',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    ...change
  }
}

export function accountReceipt(
  change: Partial<AgentLaunchAccountReceipt> = {}
): AgentLaunchAccountReceipt {
  return {
    policy: 'best-verified',
    hostId: 'local',
    provider: 'claude',
    label: 'a@example.com',
    choiceId: 'managed:a',
    remainingPercent: 72,
    boundBy: 'weekly',
    readingAt: NOW - 12_000,
    readingAgeMs: 12_000,
    fableVerified: false,
    verified: 2,
    considered: 3,
    excluded: [],
    why: 'most fresh verified headroom',
    ...change
  }
}

export function launchLoad(loadPerCore: number): AgentLaunchLoad {
  return { loadPerCore, band: hostLoadBand(loadPerCore), liveSessions: 2, observedAt: NOW - 1_000 }
}

export function readinessResult(
  change: Partial<AgentLaunchReadinessResult> = {}
): AgentLaunchReadinessResult {
  return {
    runtimeId: 'rt-1',
    workspace: {
      id: 'repo-1::/w/omni-ide',
      hostId: 'local',
      kind: 'git',
      path: '/w/omni-ide',
      name: null
    },
    account: { verified: true, receipt: accountReceipt() },
    load: launchLoad(0.3),
    machineId: null,
    ...change
  }
}

export function capacityRow(change: Partial<AccountCapacityRow> = {}): AccountCapacityRow {
  return {
    provider: 'claude',
    accountId: 'a',
    choiceId: 'managed:a',
    email: 'a@example.com',
    detail: null,
    isDefault: true,
    isSystem: false,
    fiveHour: { remainingPercent: 80, resetsAt: NOW + 3_600_000, windowMinutes: 300 },
    weekly: { remainingPercent: 64, resetsAt: NOW + 86_400_000, windowMinutes: 10080 },
    fableWeekly: null,
    state: 'ready',
    signedOutReason: null,
    limitedUntil: null,
    readingAt: NOW - 20_000,
    readingPausedUntil: null,
    sourceLabel: null,
    launchEnv: { CLAUDE_CONFIG_DIR: '/home/me/.claude-a' },
    ...change
  }
}

export function rpcError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

/** An answer, a function of the params, or a thrown error; an unlisted method is not found. */
export type FakeRuntimeAnswers = Record<string, unknown>

export type FakeRuntime = LaunchRpcClient & { calls: { method: string; params: unknown }[] }

export function fakeRuntime(answers: FakeRuntimeAnswers): FakeRuntime {
  const calls: FakeRuntime['calls'] = []
  const call = async (method: string, params?: unknown) => {
    calls.push({ method, params })
    if (!(method in answers)) {
      throw rpcError('method_not_found', `Unknown method: ${method}`)
    }
    const answer = answers[method]
    const result =
      typeof answer === 'function' ? await (answer as (sent: unknown) => unknown)(params) : answer
    if (result instanceof Error) {
      throw result
    }
    return { id: 'rpc', ok: true as const, result, _meta: { runtimeId: 'rt-1' } }
  }
  return { calls, call: call as unknown as LaunchRpcClient['call'] }
}
