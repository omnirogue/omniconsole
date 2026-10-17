import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '../../../shared/child-process/run-process'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import { localWorkflowProviderLabel } from '../../../shared/local-workflow-model-label'
import {
  codexHomeProcessLockReleased,
  tryWithCodexHomeProcessLock
} from '../../codex-cli/codex-home-process-lock'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { WORKFLOW_CODEX_LOGIN_MARGIN_MS } from './local-workflow-codex-launch'
import { guarded, timeoutFor, WORKFLOW_MAX_OUTPUT_BYTES } from './local-workflow-provider-launch'
import {
  workflowCurrentProgram,
  workflowLaunchMode,
  workflowLaunchPrompt,
  type WorkflowLaunchMode
} from './local-workflow-provider-commands'
import {
  WorkflowHostLostError,
  WorkflowAttemptUnverifiableError,
  WorkflowNoLaunchError,
  type WorkflowAttemptAccount,
  type WorkflowAttemptLaunch
} from './workflow-durable-call'
import { workflowFleetSshArgs } from './local-workflow-fleet-hosts'
import { workflowFleetCodexLoginRefreshesWithin } from './workflow-fleet-codex-login'
import {
  WORKFLOW_FLEET_SEAT_ROUTES,
  type WorkflowFleetSeatRoute
} from './workflow-fleet-host-probe'
import { workflowFleetRemoteCommand } from './workflow-fleet-remote-shell'
import {
  workflowFleetSeatCommand,
  type WorkflowFleetDispatched,
  type WorkflowFleetSeatCommand
} from './workflow-fleet-seat-command'
import { createWorkflowLocalProcessLaunch } from './workflow-local-process-launch'
import { NOOP_WORKFLOW_LIVE_OBSERVER, type WorkflowLiveObserver } from './workflow-live-observer'
import { createWorkflowLiveStream } from './workflow-live-stream'
import { storedWorkflowLine } from './workflow-stored-output'
import { workflowCallStallMs } from './workflow-call-timeout'
import { workflowCallStalledAfter } from './workflow-native-result'
import { workflowFleetSeatVerdict, type WorkflowFleetSeatVerdict } from './workflow-fleet-seat-stop'
export { workflowFleetSeatVerdict, type WorkflowFleetSeatVerdict } from './workflow-fleet-seat-stop'

const FETCH_TIMEOUT_MS = 60_000

export type WorkflowFleetSeatDeps = {
  run?: (spec: ProcessSpec) => Promise<ProcessResult>
}

function dispatched(snapshot: LocalWorkflowHostSnapshot): WorkflowFleetDispatched {
  const placement = snapshot.host.placement
  if (placement?.mode !== 'dispatched-seats' || !placement.host?.ssh || !placement.dispatch?.root) {
    throw new Error('This run was not placed on a fleet host with dispatched seats.')
  }
  return placement as WorkflowFleetDispatched
}

function isFleetRoute(route: string): route is WorkflowFleetSeatRoute {
  return (WORKFLOW_FLEET_SEAT_ROUTES as readonly string[]).includes(route)
}

/** SSH's own last word, without its `ssh: ` prefix (the message adds one). */
function lastLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^ssh:\s*/, ''))
    .findLast(Boolean)
    ?.slice(0, 200)
}

/** The named failure for a seat whose SSH connection ended in an SSH error. */
export function workflowFleetHostLostMessage(input: {
  host: string
  callId: string
  verdict: WorkflowFleetSeatVerdict
  stderr: string
  retrying?: boolean
}): string {
  const ssh = lastLine(input.stderr)
  const where =
    input.verdict === 'not-started'
      ? `before ${input.callId} started there`
      : input.verdict === 'unverifiable'
        ? `during ${input.callId}`
        : `while ${input.callId} ran there`
  const process =
    input.verdict === 'not-started'
      ? ''
      : ` Its seat process there is ${input.verdict === 'live' ? 'live (asked to stop)' : input.verdict}.`
  const next = input.retrying ? 'The call failed; remaining steps can continue' : 'The run stopped'
  return `Lost contact with ${input.host} ${where}${ssh ? ` (ssh: ${ssh})` : ''}.${process} ${next}; nothing moved to this computer.`
}

/** Brings the seat's Codex session log home, where attestation reads it (attestNativeResult). */
async function fetchCodexSessions(
  alias: string,
  directory: string,
  localHome: string,
  deps: WorkflowFleetSeatDeps
): Promise<void> {
  await mkdir(localHome, { recursive: true, mode: 0o700 })
  await (deps.run ?? runProcess)({
    program: 'scp',
    args: [
      '-q',
      '-r',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=3',
      `${alias}:${directory}/codex-home/sessions`,
      localHome
    ],
    timeoutMs: FETCH_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024
  }).catch(() => undefined)
}

/**
 * The launch for a `dispatched-seats` run: each attempt's CLI runs on the placed host over SSH
 * (the same `ssh -o BatchMode=yes` the placement reads over), on that host's own subscription
 * login. This computer keeps the ledger, the receipts (its SSH process, with the host named in
 * launch.json) and the attestation, which reads the seat's own output and, for Codex, its session
 * log copied home. Codex calls on one host take its login one at a time only while a call could
 * refresh it, as read on the host just before each launch. A lost host stops the run by name,
 * unless contact is back and the seat is gone: then the call retries there once, at once.
 */
export function launchWorkflowFleetSeats(input: {
  snapshot: LocalWorkflowHostSnapshot
  executionId: string
  fence: number
  hostId: string
  ownerIncarnation: string
  /** This computer's folder for the run's attempts (receipts, inputs, copied session logs). */
  directory: string
  observer?: WorkflowLiveObserver
  deps?: WorkflowFleetSeatDeps
}): WorkflowAttemptLaunch {
  const { snapshot } = input
  const placement = dispatched(snapshot)
  const deps = input.deps ?? {}
  const live = guarded(input.observer ?? NOOP_WORKFLOW_LIVE_OBSERVER)
  const host = placement.host
  const attempt: WorkflowAttemptLaunch = async (call) => {
    const refuse = (reason: string) => {
      call.recordNoLaunch(reason)
      return new WorkflowNoLaunchError(reason)
    }
    const seat = snapshot.seats
      .concat(snapshot.graph?.spareSeats ?? [])
      .find((entry) => entry.id === call.call.seatId)
    if (!seat) {
      throw refuse('This step has no model assigned in the saved run.')
    }
    if (!isFleetRoute(seat.agent)) {
      throw refuse(
        `${localWorkflowProviderLabel(seat.agent)} cannot run on ${host.name}; its seats run Claude and Codex.`
      )
    }
    const base = workflowLaunchMode(snapshot, call.call)
    const root = placement.dispatch.workspace?.path
    if (base.access === 'workspace-read' && !root) {
      throw refuse(`${host.name} has no copy of the files this run reads.`)
    }
    const mode: WorkflowLaunchMode = base.access === 'workspace-read' ? { ...base, root } : base
    const timeoutMs = timeoutFor(call.call.timeoutMs, mode, seat.agent)
    const prompt = workflowLaunchPrompt(
      call.call.prompt,
      workflowCurrentProgram(snapshot) ? call.rejection : null
    )
    const inputs = join(input.directory, 'inputs', call.attemptId)
    let command: WorkflowFleetSeatCommand
    try {
      command = workflowFleetSeatCommand({
        placement,
        seat: seat as ResolvedLocalWorkflowSeat & { agent: WorkflowFleetSeatRoute },
        attemptId: call.attemptId,
        mode,
        schema: call.call.schema,
        timeoutMs
      })
      await mkdir(inputs, { recursive: true, mode: 0o700 })
    } catch (cause) {
      throw refuse(cause instanceof Error ? cause.message : String(cause))
    }
    live.starting(call.call.id, call.attemptId)
    const onLine = createWorkflowLiveStream(
      seat.agent,
      (update) => live.update(call.call.id, call.attemptId, update),
      { root: mode.root }
    )
    // Checked with no await before the launch's own check: a stopped run never starts a seat.
    if (call.signal.aborted) {
      throw refuse(`The run stopped before ${call.call.id} started on ${host.name}.`)
    }
    const launched = await createWorkflowLocalProcessLaunch({
      directory: input.directory,
      executionId: input.executionId,
      hostId: input.hostId,
      ownerIncarnation: input.ownerIncarnation,
      fence: input.fence,
      command: () => ({
        program: 'ssh',
        args: workflowFleetSshArgs(host.ssh, workflowFleetRemoteCommand(command.script)),
        cwd: inputs,
        input: prompt
      }),
      timeoutMs,
      stallMs: workflowCallStallMs(mode.stream, seat.agent),
      maxOutputBytes: WORKFLOW_MAX_OUTPUT_BYTES,
      storeLine: (line) => storedWorkflowLine(seat.agent, line),
      onLine,
      onSpawned: (at) => live.spawned(call.call.id, call.attemptId, at),
      onExited: (at) => live.exited(call.call.id, call.attemptId, at),
      launchEvidence: {
        dispatch: { host: host.name, machine: host.machine, directory: command.directory }
      }
    })(call)
    const stalled = workflowCallStalledAfter(launched.result) !== undefined
    const ended = call.signal.aborted || launched.result.timedOut || stalled
    // ssh exits 255 for its own errors: the connection, not the seat, ended. It also exits 255
    // when this launch ends it (a stop, timeout or stall), which is not a lost host.
    if (launched.result.code === 255 && !ended) {
      const verdict = await workflowFleetSeatVerdict(host.ssh, command.directory, true, deps)
      const lost = {
        host: host.name,
        callId: call.call.id,
        verdict,
        stderr: launched.result.stderr
      }
      // The probe answered and found no seat running, so contact is back: retry there at once.
      const gone = verdict === 'exited' || verdict === 'not-started'
      throw new WorkflowHostLostError(
        workflowFleetHostLostMessage({ ...lost, retrying: gone }),
        launched,
        gone ? workflowFleetHostLostMessage({ ...lost, retrying: true }) : undefined
      )
    }
    if (ended) {
      // Ending the SSH process only closes the seat's pipes; stop the CLI on the host too.
      const stopped = await workflowFleetSeatVerdict(host.ssh, command.directory, true, deps)
      if (stopped !== 'exited' && stopped !== 'not-started') {
        throw new WorkflowAttemptUnverifiableError(
          `The seat on ${host.name} is ${stopped}; exit must be confirmed before retry.`
        )
      }
    }
    if (seat.agent === 'codex') {
      await fetchCodexSessions(host.ssh, command.directory, join(inputs, 'codex-home'), deps)
    }
    return launched
  }
  attempt.account = fleetCodexAccount(snapshot, host, live, deps)
  return attempt
}

/**
 * Codex rotates refresh tokens in the host's one auth.json, which every Codex seat there links, so
 * a call that could refresh that login takes it alone (the local rule, `workflowAccount`); every
 * other call runs at once. Once one call has refreshed the login, the rest overlap again.
 */
function fleetCodexAccount(
  snapshot: LocalWorkflowHostSnapshot,
  host: WorkflowFleetDispatched['host'],
  live: WorkflowLiveObserver,
  deps: WorkflowFleetSeatDeps
): WorkflowAttemptAccount {
  const key = `fleet:${host.machine}:codex`
  return async (call, work, signal) => {
    const seat = snapshot.seats
      .concat(snapshot.graph?.spareSeats ?? [])
      .find((entry) => entry.id === call.seatId)
    if (seat?.agent !== 'codex') {
      return { done: await work() }
    }
    const within =
      timeoutFor(call.timeoutMs, workflowLaunchMode(snapshot, call), 'codex') +
      WORKFLOW_CODEX_LOGIN_MARGIN_MS
    if (!(await workflowFleetCodexLoginRefreshesWithin(host.ssh, within, deps))) {
      return { done: await work() }
    }
    const held = tryWithCodexHomeProcessLock(key, work)
    if (held) {
      return { done: await held }
    }
    live.waiting(call.id, 'account')
    return {
      busy: async () => {
        await codexHomeProcessLockReleased(key, signal)
        live.waiting(call.id, 'slot')
      }
    }
  }
}
