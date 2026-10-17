import { readFileSync, globSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import { parseWorkflowCodexSessionEvidence } from '../../../shared/workflow-codex-command'
import { WORKFLOW_CLI_MINIMUM_VERSIONS } from '../../../shared/workflow-cli-version'
import {
  codexHomeProcessLockReleased,
  resolveCodexHomeProcessLockKey,
  tryWithCodexHomeProcessLock
} from '../../codex-cli/codex-home-process-lock'
import type { OrcaRuntimeService } from '../omni-runtime'
import { createWorkflowLocalProcessLaunch } from './workflow-local-process-launch'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { workflowFrozenSeat } from './workflow-program-snapshot'
import {
  WorkflowNoLaunchError,
  type WorkflowAttemptAccount,
  type WorkflowAttemptLaunch
} from './workflow-durable-call'
import type { WorkflowNativeAttestationInput } from './workflow-execution-service'
import { NOOP_WORKFLOW_LIVE_OBSERVER, type WorkflowLiveObserver } from './workflow-live-observer'
import { createWorkflowLiveStream } from './workflow-live-stream'
import { storedWorkflowLine } from './workflow-stored-output'
import { accountChoices } from './local-workflow-provider-catalog'
import { assertBinaryVersion, grokHome, workflowProgram } from './local-workflow-cli-programs'
import { workflowGrokLoginExpiresWithin } from './local-workflow-grok-launch'
import {
  WORKFLOW_CODEX_LOGIN_MARGIN_MS,
  workflowCodexLoginRefreshesWithin
} from './local-workflow-codex-launch'
import {
  workflowLaunchCommand,
  workflowLaunchMode,
  type WorkflowLaunchCommand,
  type WorkflowLaunchMode
} from './local-workflow-provider-commands'
import { assertWorkflowWorkspaceRoot } from './local-workflow-workspace-root'
import {
  workflowCallStallMs,
  workflowCallTimeoutMs,
  WORKFLOW_OLLAMA_FROZEN_TIMEOUT_MS,
  WORKFLOW_FROZEN_TIMEOUT_MS
} from './workflow-call-timeout'

/** Backstop only: bulky streamed lines are filtered before they count against it. */
export const WORKFLOW_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const WORKSPACE_READ_TIMEOUT_MS = 15 * 60_000
const GROK_LOGIN_MARGIN_MS = 5 * 60_000

export function attestNativeResult(input: WorkflowNativeAttestationInput): void {
  if (input.route === 'codex') {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        input.parsed.providerSessionId
      )
    ) {
      throw new Error('Codex did not report a valid session for this answer.')
    }
    const operationHome = join(
      getAppEnvironment().getPath('userData'),
      'local-workflow-attempts',
      input.executionId,
      'inputs',
      input.attemptId,
      'codex-home'
    )
    const files = globSync(
      join(operationHome, 'sessions', '**', `*${input.parsed.providerSessionId}.jsonl`)
    )
    if (files.length !== 1 || !input.seat.effort) {
      throw new Error('Codex did not record which model and settings produced this answer.')
    }
    parseWorkflowCodexSessionEvidence(readFileSync(files[0], 'utf8'), {
      sessionId: input.parsed.providerSessionId,
      model: input.seat.model,
      effort: input.seat.effort,
      cliVersion: WORKFLOW_CLI_MINIMUM_VERSIONS.codex
    })
    return
  }
  if (
    input.parsed.providerSessionId !== input.attemptId ||
    input.parsed.resolvedModels?.length !== 1 ||
    input.parsed.resolvedModels[0] !== input.seat.model
  ) {
    throw new Error('The answer came from a different session or model than this run chose.')
  }
}

/** A misbehaving live observer must never affect a launch or its evidence. */
export function guarded(observer: WorkflowLiveObserver): WorkflowLiveObserver {
  const safe =
    <A extends unknown[]>(notify: (...args: A) => void) =>
    (...args: A) => {
      try {
        notify(...args)
      } catch {
        /* Live view only. */
      }
    }
  return {
    waiting: safe(observer.waiting),
    starting: safe(observer.starting),
    spawned: safe(observer.spawned),
    update: safe(observer.update),
    exited: safe(observer.exited)
  }
}

/** The program's per-call timeout wins; otherwise minutes for workspace reads, legacy caps else. */
export function timeoutFor(
  requested: number | undefined,
  mode: WorkflowLaunchMode,
  agent: string
): number {
  const own = workflowCallTimeoutMs(requested)
  if (own !== undefined) {
    return own
  }
  if (mode.access === 'workspace-read') {
    return WORKSPACE_READ_TIMEOUT_MS
  }
  // A frozen, plan-sized Grok answer completed in 126s under a 180s
  // diagnostic cap after the same prompt timed out at the old 120s cap.
  return agent === 'ollama'
    ? WORKFLOW_OLLAMA_FROZEN_TIMEOUT_MS
    : agent === 'grok'
      ? 180_000
      : WORKFLOW_FROZEN_TIMEOUT_MS
}

function codexAccountHome(runtime: OrcaRuntimeService, accountId: string): string | undefined {
  return accountChoices(runtime, 'codex').find((choice) => choice.id === accountId)?.env.CODEX_HOME
}

/**
 * Launches that could refresh a shared login run one at a time on it. The durable agent asks here
 * once a call holds its slot; while the account is taken the call gives the slot back and waits
 * holding nothing, so neither an account nor a slot is held while waiting for the other. Codex
 * rotates refresh tokens per account home and every run links that home's auth.json, so a run that
 * could refresh it (its access token or refresh age runs out within the run plus a margin, or the
 * login cannot be read) takes the account. Each streamed Grok run refreshes the login in its own
 * private home, so a run that could outlive the login takes it too. That is judged with the slot
 * held, just before the launch, so a long wait for a slot cannot leave it stale; once one run has
 * refreshed the login, the rest run in parallel again.
 */
export function workflowAccount(
  runtime: OrcaRuntimeService,
  snapshot: LocalWorkflowHostSnapshot,
  observer: WorkflowLiveObserver = NOOP_WORKFLOW_LIVE_OBSERVER
): WorkflowAttemptAccount {
  const live = guarded(observer)
  return async (call, work, signal) => {
    const seat = workflowFrozenSeat(snapshot, call.seatId)
    const mode = workflowLaunchMode(snapshot, call)
    const exclusive = async (key: string) => {
      const held = tryWithCodexHomeProcessLock(key, work)
      if (held) {
        return { done: await held }
      }
      live.waiting(call.id, 'account')
      return {
        busy: async () => {
          await codexHomeProcessLockReleased(key, signal)
          // The account is free; the call now waits for a slot like any other.
          live.waiting(call.id, 'slot')
        }
      }
    }
    if (seat?.agent === 'codex') {
      const home = codexAccountHome(runtime, seat.accountId)
      const within = timeoutFor(call.timeoutMs, mode, 'codex') + WORKFLOW_CODEX_LOGIN_MARGIN_MS
      // Without an account the launch refuses the call and records why.
      return home && (await workflowCodexLoginRefreshesWithin(home, within))
        ? exclusive(resolveCodexHomeProcessLockKey(home))
        : { done: await work() }
    }
    if (seat?.agent !== 'grok' || !mode.stream) {
      return { done: await work() }
    }
    const account = grokHome()
    const within = timeoutFor(call.timeoutMs, mode, 'grok') + GROK_LOGIN_MARGIN_MS
    if (!(await workflowGrokLoginExpiresWithin(account, within))) {
      return { done: await work() }
    }
    return exclusive(resolveCodexHomeProcessLockKey(join(account, 'auth.json')))
  }
}

export function launch(
  runtime: OrcaRuntimeService,
  snapshot: LocalWorkflowHostSnapshot,
  executionId: string,
  fence: number,
  hostId: string,
  ownerIncarnation: string,
  observer: WorkflowLiveObserver = NOOP_WORKFLOW_LIVE_OBSERVER
): WorkflowAttemptLaunch {
  const directory = join(
    getAppEnvironment().getPath('userData'),
    'local-workflow-attempts',
    executionId
  )
  const live = guarded(observer)
  const attempt: WorkflowAttemptLaunch = async (input) => {
    const refuse = (cause: unknown) => {
      const reason = cause instanceof Error ? cause.message : String(cause)
      input.recordNoLaunch(reason)
      return new WorkflowNoLaunchError(reason)
    }
    const seat = workflowFrozenSeat(snapshot, input.call.seatId)
    if (!seat) {
      throw refuse('This step has no model assigned in the saved run.')
    }
    if (seat.agent === 'codex' && !codexAccountHome(runtime, seat.accountId)) {
      throw refuse('The selected Codex account is unavailable.')
    }
    const callId = input.call.id
    const attemptId = input.attemptId
    let mode = workflowLaunchMode(snapshot, input.call)
    const timeoutMs = timeoutFor(input.call.timeoutMs, mode, seat.agent)
    live.starting(callId, attemptId)
    let command: WorkflowLaunchCommand
    try {
      if (mode.access === 'workspace-read') {
        // Checked before every launch: agents read only the folder that was admitted.
        mode = { ...mode, root: await assertWorkflowWorkspaceRoot(snapshot) }
      }
      await assertBinaryVersion(
        seat.agent,
        input.signal,
        workflowProgram(seat.agent, mode.stream),
        seat.model
      )
      command = await workflowLaunchCommand(runtime, snapshot, seat, input, directory, mode)
      await mkdir(directory, { recursive: true, mode: 0o700 })
    } catch (cause) {
      throw refuse(cause)
    }
    const onLine = createWorkflowLiveStream(
      seat.agent,
      (update) => live.update(callId, attemptId, update),
      { root: mode.root }
    )
    const { settle, ...spec } = command
    try {
      return await createWorkflowLocalProcessLaunch({
        directory,
        executionId,
        hostId,
        ownerIncarnation,
        fence,
        command: () => spec,
        timeoutMs,
        stallMs: workflowCallStallMs(mode.stream, seat.agent),
        maxOutputBytes: WORKFLOW_MAX_OUTPUT_BYTES,
        storeLine: (line) => storedWorkflowLine(seat.agent, line),
        onLine,
        onSpawned: (at) => live.spawned(callId, attemptId, at),
        onExited: (at) => live.exited(callId, attemptId, at)
      })(input)
    } finally {
      await settle?.()
    }
  }
  attempt.account = workflowAccount(runtime, snapshot, observer)
  return attempt
}
