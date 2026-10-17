import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { SessionChainAgentStep } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import * as cleanupProtection from './automatic-worker-cleanup-hold'
import * as processTree from './orchestration/worker-release-process-tree'
import * as profilePaths from '../omni-profiles/profile-storage-paths'

/**
 * What one launched worker does, in launch order: report success, report its own failure, say
 * nothing at all (the test then settles its dispatch the way the host would see it die), or hold
 * its report until the test releases it.
 */
export type WorkerBehaviour = 'succeed' | 'report-failed' | 'silent' | 'hold'

export type RecoveryFixture = ReturnType<typeof recoveryFixture>

/**
 * Opt in tests that replace a still-live worker to the finite execution contract. The base
 * fixture deliberately has no cleanup authority. Keep admission, archive and release real;
 * provide the external profile, provider and process observations those paths require.
 */
export function finiteRecoveryWorkers(f: RecoveryFixture): void {
  const { runtime, workspace } = f
  const hostScope = { kind: 'local', hostId: 'local' } as const
  vi.mocked(runtime.showManagedTerminalWorkspace).mockResolvedValue({
    id: 'folder:outcome',
    repoId: 'folder',
    path: workspace,
    hostId: 'local'
  } as never)
  vi.spyOn(cleanupProtection, 'readAutomaticWorkerCleanupHold').mockResolvedValue(null)
  vi.spyOn(profilePaths, 'getProfileUserDataPath').mockReturnValue(workspace)
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => ({
    runtimeId: runtime.getRuntimeId(),
    terminalHandle: handle,
    ptyId: `pty-${handle}`,
    worktreeId: 'folder:outcome',
    launchTokenHash: null,
    paneKey: runtime.getTerminalPaneKey(handle)!,
    processIncarnation: runtime.getTerminalProcessIncarnation(handle)!,
    hostScope
  }))
  vi.spyOn(runtime, 'getExactWorkerProviderSession').mockImplementation((handle) => ({
    paneKey: runtime.getTerminalPaneKey(handle)!,
    processIncarnation: runtime.getTerminalProcessIncarnation(handle)!,
    agent: 'codex',
    observedAt: Date.now(),
    providerSession: {
      key: 'session_id',
      id: handle,
      transcriptPath: join(workspace, '.codex', 'sessions', `${handle}.jsonl`)
    }
  }))
  vi.spyOn(runtime, 'resolveConversationCapacityWorkspace').mockResolvedValue(workspace)
  vi.spyOn(runtime, 'readTerminal').mockImplementation(async (handle) => ({
    handle,
    status: 'running',
    tail: ['Preserved worker output'],
    truncated: false,
    nextCursor: null
  }))
  vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('live')
  vi.spyOn(processTree, 'captureWorkerReleaseProcessTree').mockImplementation(
    async (_runtime, resource) => ({
      version: 1,
      processIncarnation: resource.process_incarnation!,
      hostScope: resource.host_scope!,
      snapshot: {
        root: { pid: 100, startedAt: 'Thu Oct 1 12:00:00 2026' },
        rootPgid: 100,
        descendants: [],
        capturedAtMs: Date.now()
      }
    })
  )
  vi.spyOn(processTree, 'finishWorkerReleaseProcessTree').mockResolvedValue('exited')
}

/** The hook row the base fixture reports for every pane: a finished, idle turn. */
export function idleHook(): {
  state: 'done'
  lastAssistantMessage: null
  interactivePrompt: null
  stateStartedAt: number
  updatedAt: number
} {
  return {
    state: 'done',
    lastAssistantMessage: null,
    interactivePrompt: null,
    stateStartedAt: Date.now(),
    updatedAt: Date.now()
  }
}

/**
 * The real outcome host (RPC, sqlite, durable state) with scripted workers and ONE injectable
 * clock: every backoff, grace period and block the recovery ladder writes is measured from
 * `clock`, so a test moves time by assignment and never sleeps.
 */
export function recoveryFixture(behaviours: WorkerBehaviour[], restoreFrom?: string) {
  const reporting: WorkerBehaviour[] = []
  const f = outcomeRuntimeFixture((spec, workspace) => {
    if (reporting.shift() === 'report-failed') {
      return { body: 'The agent gave up.', outcome: 'failed' as const }
    }
    writeFileSync(join(workspace, `${/STEP:(\w+)/.exec(spec)?.[1] ?? 'result'}.txt`), 'done')
    return { body: 'DONE' }
  }, restoreFrom)
  const send = vi.mocked(f.runtime.sendTerminalAgentPrompt)
  const report = send.getMockImplementation()!
  /** The terminal handle of every worker that was handed its prompt, in launch order. */
  const handles: string[] = []
  const held: (() => Promise<unknown>)[] = []
  send.mockImplementation(async (handle, prompt, options) => {
    const behaviour = behaviours[handles.length] ?? 'succeed'
    handles.push(handle)
    if (behaviour === 'silent') {
      return { handle, accepted: true, bytesWritten: prompt.length }
    }
    if (behaviour === 'hold') {
      held.push(async () => {
        reporting.push('succeed')
        await report(handle, prompt, options)
      })
      return { handle, accepted: true, bytesWritten: prompt.length }
    }
    reporting.push(behaviour)
    return report(handle, prompt, options)
  })
  const state = { clock: Date.now() }
  // The service reads its clock through this field; the ladder and the seal both follow it.
  ;(f.service as unknown as { now: () => number }).now = () => state.clock
  const attempts = (chainId = 'chain'): SessionOutcomeAttempt[] =>
    f.service.get(chainId).outcomeSet!.attempts
  return Object.assign(f, {
    handles,
    attempts,
    /** Move the host's clock forward. */
    advance: (ms: number): void => {
      state.clock += ms
    },
    now: (): number => state.clock,
    /** Let a held worker report its success. */
    release: async (): Promise<void> => {
      await held.shift()!()
    },
    progress: (chainId = 'chain') =>
      sessionOutcomeProgress(f.service.get(chainId).outcomeSet!, { now: state.clock }),
    /** Tick until the record says so; a bound instead of a count, so launch timing never matters. */
    settleUntil: async (done: () => boolean, passes = 12): Promise<void> => {
      for (let pass = 0; pass < passes && !done(); pass++) {
        await f.settle()
      }
      if (!done()) {
        throw new Error('The outcome host did not reach the expected state.')
      }
    }
  })
}

/** Commit a one-stage plan whose Done When is the file its worker writes (`<stepId>.txt`). */
export async function commitOneStagePlan(
  f: RecoveryFixture,
  input: { chainId?: string; stepId?: string; sourcePaneKey?: string } = {}
): Promise<void> {
  const stepId = input.stepId ?? 'work'
  const steps = [
    { id: stepId, outcomeId: stepId, agent: 'codex', prompt: `STEP:${stepId}`, status: 'queued' }
  ] as SessionChainAgentStep[]
  await f.service.commit(
    {
      id: input.chainId ?? 'chain',
      workspacePath: f.workspace,
      worktreeId: 'folder:outcome',
      hostId: 'local',
      sourcePaneKey: input.sourcePaneKey ?? 'source',
      sourceRowKey: 'row',
      auto: true,
      steps,
      currentIndex: 0,
      state: 'waiting',
      createdAt: 1,
      updatedAt: 1
    },
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: stepId,
          title: `Ship ${stepId}`,
          finish: 'complete',
          dependsOn: [],
          stepIds: [stepId],
          actions: [],
          conditions: [{ id: 'file', kind: 'file', target: join(f.workspace, `${stepId}.txt`) }]
        }
      ]
    }
  )
  f.service.dispose()
}

/** The attempt the chain is running now: the newest one that was not replaced. */
export function liveAttempt(f: RecoveryFixture, chainId = 'chain'): SessionOutcomeAttempt {
  return f.attempts(chainId).findLast((attempt) => attempt.state !== 'retryable')!
}

/** Wait for a silent or held worker to be running under a dispatch the test can settle. */
export async function runningAttempt(
  f: RecoveryFixture,
  chainId = 'chain'
): Promise<SessionOutcomeAttempt & { dispatchId: string }> {
  await f.settleUntil(() => {
    const attempt = f.attempts(chainId).findLast((entry) => entry.state !== 'retryable')
    return Boolean(attempt?.dispatchId && attempt.state === 'running')
  })
  return liveAttempt(f, chainId) as SessionOutcomeAttempt & { dispatchId: string }
}
