import type { SessionChain } from '../../shared/session-chain-types'
import { createHash } from 'node:crypto'
import { makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import type {
  SessionOutcomeAction,
  SessionOutcomeAttempt
} from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { createDesktopCoordinator } from './orchestration/desktop-coordinator'
import { createOrchestrationCaller } from './build-review/build-review-rpc-call'
import { SessionOutcomeTaskContinuationError } from './session-outcome-task-continuation'
import type { SessionOutcomeLaunchDetach } from './session-outcome-launch-detach'
import { launchNotStartedFailure } from './session-outcome-attempt-failure'
import { deriveRemoteRuntimeTerminalCreateHandle } from './remote-runtime-terminal-create-identity'

/**
 * How a launch that threw is recorded. `prepared` is the durable checkpoint before any worker can
 * exist, so a failure there proves nothing started; past it, lost contact is not proof of exit and
 * the attempt stays unverifiable rather than being repeated.
 */
export function failedSessionOutcomeAttempt(
  attempt: SessionOutcomeAttempt,
  error: unknown,
  now = Date.now()
): SessionOutcomeAttempt {
  const notStarted =
    !(error instanceof SessionOutcomeCoordinatorOwnershipUnavailableError) &&
    (attempt.state === 'prepared' ||
      (error instanceof SessionOutcomeTaskContinuationError &&
        error.launchDisposition === 'not-started'))
  return {
    ...attempt,
    state: notStarted ? 'blocked' : 'unverifiable',
    launchDisposition: notStarted ? 'not-started' : 'unverifiable',
    error: error instanceof Error ? error.message : String(error),
    // Only a launch that provably never started carries a code the ladder may retry on.
    ...(notStarted ? { failure: launchNotStartedFailure(error, now) } : {}),
    updatedAt: now
  }
}

type LocalWorkerLaunch = {
  runtime: OrcaRuntimeService
  chain: SessionChain
  outcomeId: string
  action: SessionOutcomeAction
  brief: string
  attempt: SessionOutcomeAttempt
  persist: (attempt: SessionOutcomeAttempt) => void
  detach?: SessionOutcomeLaunchDetach
}

type LaunchCheckpoint = (attempt: SessionOutcomeAttempt) => Promise<void> | void

/** One outcome action keeps one coordinator identity across retries and host restarts. */
export function sessionOutcomeCoordinatorHandle(
  chain: Pick<SessionChain, 'id' | 'worktreeId'>,
  attempt: Pick<SessionOutcomeAttempt, 'outcomeId' | 'actionId' | 'outcomeRevision' | 'planVersion'>
): string {
  return deriveRemoteRuntimeTerminalCreateHandle(
    'session-outcome-coordinator',
    chain.worktreeId,
    JSON.stringify([
      chain.id,
      attempt.outcomeId,
      attempt.actionId,
      attempt.outcomeRevision,
      attempt.planVersion ?? 1
    ])
  )
}

/** A local outcome coordinator owns one stable pane, including while its renderer reattaches. */
export function sessionOutcomeCoordinatorPaneKey(
  chain: Pick<SessionChain, 'id' | 'worktreeId'>,
  attempt: Pick<SessionOutcomeAttempt, 'outcomeId' | 'actionId' | 'outcomeRevision' | 'planVersion'>
): string {
  const digest = createHash('sha256')
    .update('omni.session-outcome-coordinator-pane.v1\0')
    .update(chain.worktreeId)
    .update('\0')
    .update(
      JSON.stringify([
        chain.id,
        attempt.outcomeId,
        attempt.actionId,
        attempt.outcomeRevision,
        attempt.planVersion ?? 1
      ])
    )
    .digest('hex')
  const leaf = digest.slice(0, 32).split('')
  leaf[12] = '4'
  leaf[16] = ((Number.parseInt(leaf[16]!, 16) & 0x3) | 0x8).toString(16)
  const leafId = leaf.join('')
  return makePaneKey(
    `outcome-${digest.slice(32, 48)}`,
    `${leafId.slice(0, 8)}-${leafId.slice(8, 12)}-${leafId.slice(12, 16)}-${leafId.slice(
      16,
      20
    )}-${leafId.slice(20)}`
  )
}

class SessionOutcomeCoordinatorOwnershipUnavailableError extends Error {}

function coordinatorPaneKey(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  attempt: SessionOutcomeAttempt,
  handle: string
): string {
  if (parsePaneKey(attempt.coordinatorPaneKey ?? '')) {
    return attempt.coordinatorPaneKey!
  }
  const run = attempt.runId ? runtime.getOrchestrationDb().getRun(attempt.runId) : undefined
  const runPaneKey = run?.coordinator_handle === handle ? run.coordinator_pane_key : null
  if (runPaneKey && parsePaneKey(runPaneKey)) {
    return runPaneKey
  }
  const livePaneKey = runtime.getLiveTerminalPaneKey(handle)
  if (livePaneKey && parsePaneKey(livePaneKey)) {
    return livePaneKey
  }
  if (attempt.coordinatorHandle) {
    throw new SessionOutcomeCoordinatorOwnershipUnavailableError(
      'The previous coordinator has no durable pane identity to adopt.'
    )
  }
  return sessionOutcomeCoordinatorPaneKey(chain, attempt)
}

function sameCoordinatorPane(expected: string, actual: string): boolean {
  return parsePaneKey(expected)?.leafId === parsePaneKey(actual)?.leafId
}

/**
 * Start a worker for this action on its own local Run. The readiness wait is the slow part — up to
 * 180 s — and with `detach` it runs AFTER the tick that asked for it: the attempt is already
 * durable at `prepared`, so a host that dies mid-wait reconciles it from its receipts instead of
 * dispatching a second agent, and no other chain waits behind this one.
 */
export function startLocalSessionOutcomeWorker(
  input: LocalWorkerLaunch
): Promise<SessionOutcomeAttempt> {
  const started = async (persist: LaunchCheckpoint): Promise<SessionOutcomeAttempt> => {
    let attempt = input.attempt
    // Each checkpoint is durable before the next external step: a host that cannot record what it
    // is about to do must not do it, or a resume would dispatch a worker nobody knows about.
    const write = async (next: SessionOutcomeAttempt): Promise<SessionOutcomeAttempt> => {
      attempt = next
      await persist(next)
      return next
    }
    try {
      const call = createOrchestrationCaller(input.runtime)
      const coordinatorHandle =
        attempt.coordinatorHandle ?? sessionOutcomeCoordinatorHandle(input.chain, attempt)
      const stablePaneKey = coordinatorPaneKey(
        input.runtime,
        input.chain,
        attempt,
        coordinatorHandle
      )
      if (
        attempt.coordinatorHandle !== coordinatorHandle ||
        attempt.coordinatorPaneKey !== stablePaneKey
      ) {
        await write({ ...attempt, coordinatorHandle, coordinatorPaneKey: stablePaneKey })
      }
      const liveCoordinator = input.runtime.getLiveTerminalPaneKey(coordinatorHandle)
      if (liveCoordinator && !sameCoordinatorPane(stablePaneKey, liveCoordinator)) {
        throw new SessionOutcomeCoordinatorOwnershipUnavailableError(
          'The coordinator handle belongs to a different stable pane.'
        )
      }
      if (!liveCoordinator) {
        const pane = parsePaneKey(stablePaneKey)
        if (!pane) {
          throw new SessionOutcomeCoordinatorOwnershipUnavailableError(
            'The coordinator has no valid stable pane identity.'
          )
        }
        const created = await createDesktopCoordinator(
          input.runtime,
          input.chain.worktreeId,
          'Outcome continuation',
          {
            launchCause: { trigger: 'outcome', reference: { outcomeChainId: input.chain.id } },
            preAllocatedHandle: coordinatorHandle,
            paneIdentity: pane
          }
        )
        if (created !== coordinatorHandle) {
          await write({ ...attempt, state: 'launching', updatedAt: Date.now() })
          throw new Error('The outcome coordinator did not keep its durable identity.')
        }
      }
      // A Run request can be accepted before its response reaches us. From here a retry must
      // reconcile rather than claim nothing started.
      if (attempt.state === 'prepared') {
        await write({ ...attempt, state: 'launching', updatedAt: Date.now() })
      }
      const created = await call<{ run: { id: string; hub_task_id?: string | null } }>(
        'orchestration.runCreate',
        {
          objective: input.chain.outcomeSet!.outcomes.find((entry) => entry.id === input.outcomeId)!
            .title,
          from: coordinatorHandle
        }
      )
      if (created.run.hub_task_id) {
        throw new Error('Card-bound work requires the existing workflow admission adapter.')
      }
      await write({ ...attempt, runId: created.run.id })
      const task = await call<{ task: { id: string } }>('orchestration.taskCreate', {
        spec: input.brief,
        taskTitle: input.action.id,
        run: created.run.id,
        callerTerminalHandle: coordinatorHandle
      })
      // The launch intent is fsynced before workerStart; an uncertain response is reconciled, never retried.
      await write({ ...attempt, taskId: task.task.id, state: 'launching', updatedAt: Date.now() })
      const ready = await call<{ dispatchId: string; state: string; lastError?: string }>(
        'orchestration.workerStart',
        {
          task: task.task.id,
          from: coordinatorHandle,
          worktree: `id:${input.chain.worktreeId}`,
          agent: input.action.agent,
          ...(input.action.model ? { model: input.action.model } : {}),
          ...(input.action.openrouterCandidates !== undefined
            ? { openrouterCandidates: [...input.action.openrouterCandidates] }
            : {}),
          ...(input.action.effort ? { effort: input.action.effort } : {}),
          ...(input.action.accountChoiceId
            ? { accountChoiceId: input.action.accountChoiceId }
            : {}),
          executionBrief: input.brief,
          timeoutMs: 180_000
        }
      )
      return await write({
        ...attempt,
        dispatchId: ready.dispatchId,
        // A Dispatch exists: this launch started, whatever the agent does next. Retrying it would
        // be a second worker, so only a settled failure may make it retryable.
        launchDisposition: 'started',
        state: ready.state === 'ready' ? 'running' : 'unverifiable',
        updatedAt: Date.now(),
        ...(ready.lastError ? { error: ready.lastError } : {})
      })
    } catch (error) {
      return await write(failedSessionOutcomeAttempt(attempt, error))
    }
  }
  if (!input.detach) {
    return started(input.persist)
  }
  input.detach(input.attempt.id, async (persist) => {
    await started(persist)
  })
  return Promise.resolve(input.attempt)
}
