import {
  installDeviceAttributesResponder,
  STARTUP_DA1_RESPONSE
} from './startup-device-attributes-responder'
import { PostReadyFlushGate } from './post-ready-flush-gate'
import {
  createShellStartupOutputScanState,
  drainShellStartupOutputScanState,
  scanShellStartupOutput,
  type ShellStartupOutputScanState
} from '../shell-startup-output-scanner'
import {
  createShellPromptReadinessProbe,
  type ShellPromptReadinessProbe
} from '../shell-prompt-readiness-probe'
import type { HeadlessEmulator } from './headless-emulator'
import type { SubprocessHandle } from './session-subprocess-handle'
import { basename } from 'node:path'
import type { ShellReadyState } from './types'
import { recordLaunchGateShellIdentity } from '../providers/pty-launch-gate-shell-identity'
import { decideAdaptiveShellReadyWait } from './session-shell-ready-adaptive-bound'
import type { DaemonLaunchStageName, LaunchStageReporter } from './session-launch-stage-report'

const SHELL_READY_TIMEOUT_MS = 15_000
// Re-exported under its historical name: the Codex floor now lives beside the
// adaptive extension policy that owns it.
export { CODEX_SHELL_READY_TIMEOUT_MS } from './session-shell-ready-adaptive-bound'

export type SessionShellReadyBarrierDeps = {
  sessionId: string
  subprocess: SubprocessHandle
  /** Captured before a launch gate replaces subprocess.write; only the DA1 responder uses it. */
  writeDeviceAttributesResponse?: (data: string) => void
  responderParser: HeadlessEmulator['responderParser']
  shellReadySupported: boolean
  shellReadyTimeoutMs: number | undefined
  /** Upper bound the shell-ready wait may adaptively grow to while nothing yet
   *  proves the shell is alive. Absent ⇒ today's fixed bound. */
  shellReadyAdaptiveCapMs?: number | undefined
  installDeviceAttributesFilter(): void
  releaseDeviceAttributesFilter(): void
  acceptStartupIngress(data: string): void
  /** Reports a readiness outcome worth diagnosing. Why injected rather than
   *  console: the daemon runs detached with stdio 'ignore', so console output
   *  goes nowhere -- the only durable sink is the daemon's NDJSON file log. */
  reportReadinessEvent?(event: string, details: Record<string, unknown>): void
  /** Reports launch-stage timings. A separate sink from the readiness events
   *  above so neither stream's contract depends on the other's volume. */
  reportLaunchStage?: LaunchStageReporter
}

/** The startup gate every byte of PTY output passes through: it strips the shell-ready marker, holds
 *  stdin until the shell can accept it, and owns DA1 authority for as long as the gate is closed. */
export class SessionShellReadyBarrier {
  private _state: ShellReadyState
  private scanState: ShellStartupOutputScanState | null = null
  private shellStartupPid: number | null = null
  private promptReadinessProbe: ShellPromptReadinessProbe | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private releaseDeviceAttributesResponder: (() => void) | null = null
  private preReadyStdinQueue: string[] = []
  private readonly postReadyFlushGate: PostReadyFlushGate
  private readonly armedAtMs = Date.now()
  private shellOutputObserved = false
  private reportedLaunchStages = new Set<string>()

  constructor(private readonly deps: SessionShellReadyBarrierDeps) {
    const reply = deps.writeDeviceAttributesResponse ?? deps.subprocess.write.bind(deps.subprocess)
    if (deps.shellReadySupported) {
      this._state = 'pending'
      this.scanState = createShellStartupOutputScanState()
      // Why: `write` queues everything until the ready marker, including the renderer's DA1
      // reply — and a shell that withholds its first prompt until DA1 is answered (fish) then
      // never emits the marker that would release it. Answer from the daemon, past the queue.
      this.releaseDeviceAttributesResponder = installDeviceAttributesResponder({
        parser: deps.responderParser,
        response: STARTUP_DA1_RESPONSE,
        reply
      })
      deps.installDeviceAttributesFilter()
      this.armReadyTimer(this.baseTimeoutMs)
    } else {
      this._state = 'unsupported'
    }

    this.postReadyFlushGate = new PostReadyFlushGate(() => this.flushPreReadyQueue())
  }

  private get baseTimeoutMs(): number {
    return this.deps.shellReadyTimeoutMs ?? SHELL_READY_TIMEOUT_MS
  }

  private armReadyTimer(waitMs: number): void {
    this.readyTimer = setTimeout(() => {
      this.onShellReadyTimeout()
    }, waitMs)
  }

  get state(): ShellReadyState {
    return this._state
  }

  /** True while stdin must be queued: pre-marker, or inside the post-ready flush-gate window. */
  get isGatingWrites(): boolean {
    return this._state === 'pending' || this.postReadyFlushGate.isPending
  }

  /** Started after the startup ingress exists, matching the order the probe's callbacks assume. */
  startPromptReadinessProbe(): void {
    if (this._state !== 'pending') {
      return
    }
    this.promptReadinessProbe = createShellPromptReadinessProbe({
      slavePath: this.deps.subprocess.slavePath,
      shellPath: this.deps.subprocess.shellPath,
      shellCwd: this.deps.subprocess.shellCwd,
      shellPathEnv: this.deps.subprocess.shellPathEnv,
      getShellPid: () => this.shellStartupPid,
      onPromptReady: () => this.onShellPromptReady()
    })
  }

  /** Queues `data` when the gate is closed; false means the caller must write it through. */
  tryEnqueue(data: string): boolean {
    if (!this.isGatingWrites) {
      return false
    }
    this.preReadyStdinQueue.push(data)
    return true
  }

  ingestSubprocessData(data: string): void {
    let releaseStartupDeviceAttributes = false
    if (data.length > 0) {
      // Evidence the shell is past its profile; the adaptive bound stops extending.
      this.shellOutputObserved = true
    }
    if (this._state === 'pending' && this.scanState) {
      const scanned = scanShellStartupOutput(this.scanState, data)
      data = scanned.output
      if (scanned.shellPid) {
        this.shellStartupPid = scanned.shellPid
        recordLaunchGateShellIdentity(this.deps.subprocess, scanned.shellPid)
      }
      if (scanned.ready) {
        this.transitionToReady(scanned.postMarkerBytesObserved)
        releaseStartupDeviceAttributes = true
      }
    } else {
      this.postReadyFlushGate.notifyData()
    }

    this.deps.acceptStartupIngress(data)
    if (this._state === 'pending' && data.length > 0) {
      this.promptReadinessProbe?.notifyOutput(data)
    }
    if (releaseStartupDeviceAttributes) {
      this.releaseDeviceAttributes()
    }
  }

  releaseHeldBytes(): string {
    if (!this.scanState) {
      return ''
    }
    const heldBytes = drainShellStartupOutputScanState(this.scanState)
    this.scanState = null
    // Why: scanning strips marker bytes before fan-out; if readiness never completes, release any held prefix before timeout/exit discards it.
    this.deps.acceptStartupIngress(heldBytes)
    return heldBytes
  }

  /** Hands DA1 back to the renderer once the barrier is done, however it ended. */
  releaseDeviceAttributes(): void {
    this.releaseDeviceAttributesResponder?.()
    this.releaseDeviceAttributesResponder = null
    this.deps.releaseDeviceAttributesFilter()
  }

  disposePromptReadinessProbe(): void {
    this.promptReadinessProbe?.dispose()
    this.promptReadinessProbe = null
  }

  clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
  }

  /** Drops queued stdin and the flush gate; teardown does this, and dispose repeats it defensively. */
  clearPendingWrites(): void {
    this.preReadyStdinQueue = []
    this.postReadyFlushGate.clear()
  }

  clearFlushGate(): void {
    this.postReadyFlushGate.clear()
  }

  dispose(): void {
    this.clearReadyTimer()
    this.disposePromptReadinessProbe()
    this.scanState = null
    this.clearPendingWrites()
  }

  private transitionToReady(postMarkerBytesObserved = false, outcome = 'ready_marker'): void {
    this.reportLaunchStage('shell_ready', outcome)
    this._state = 'ready'
    this.scanState = null
    this.disposePromptReadinessProbe()
    this.clearReadyTimer()
    if (this.preReadyStdinQueue.length === 0) {
      return
    }
    this.postReadyFlushGate.arm(postMarkerBytesObserved)
  }

  /** Why the shell basename and not its path: the path can carry a home dir, and
   *  the basename is all a diagnosis needs. The session id is already logged by
   *  the daemon's session lifecycle events, so it is only correlation here. */
  private reportReadiness(event: string, details: Record<string, unknown>): void {
    const shellPath = this.deps.subprocess.shellPath
    try {
      this.deps.reportReadinessEvent?.(event, {
        sessionId: this.deps.sessionId,
        shell: shellPath ? basename(shellPath) : 'unknown',
        ...details
      })
    } catch {
      // Why swallow: this runs before the state transition that releases held
      // PTY bytes and flushes queued stdin, and the ready timer is already
      // cleared. A throwing sink must never strand the barrier in `pending`
      // with nothing left to wake it -- diagnostics cannot break the terminal.
    }
  }

  private onShellReadyTimeout(): void {
    this.readyTimer = null
    if (this._state !== 'pending') {
      return
    }
    // Why adaptive: Codex's bound is 300 ms against 15 s for other agents, and a
    // loaded Mac regularly needs longer just to source the profile. A shell that
    // has neither announced its PID nor printed a byte is still booting, so
    // flushing stdin now writes the startup command into a shell that will eat it.
    const decision = decideAdaptiveShellReadyWait({
      baseTimeoutMs: this.baseTimeoutMs,
      elapsedMs: Date.now() - this.armedAtMs,
      capMs: this.deps.shellReadyAdaptiveCapMs,
      probeIdentifiedShell: this.shellStartupPid !== null,
      shellOutputObserved: this.shellOutputObserved
    })
    if (decision.action === 'extend') {
      this.reportReadiness('shell-ready-timeout-extended', {
        timeoutMs: this.baseTimeoutMs,
        elapsedMs: decision.elapsedMs,
        capMs: this.deps.shellReadyAdaptiveCapMs,
        waitMs: decision.waitMs
      })
      this.armReadyTimer(decision.waitMs)
      return
    }
    // Why report: this path costs every startup command the full timeout, and it
    // used to fail silently -- a wrapper that never emits the marker looks
    // identical to a slow shell. Name the shell so the next report can be
    // diagnosed from the log alone.
    this.reportReadiness('shell-ready-timeout', {
      timeoutMs: this.baseTimeoutMs,
      elapsedMs: decision.elapsedMs,
      ...(this.deps.shellReadyAdaptiveCapMs === undefined
        ? {}
        : { capMs: this.deps.shellReadyAdaptiveCapMs, outcome: 'expired' })
    })
    this.reportLaunchStage('shell_ready', 'timeout_expired')
    this._state = 'timed_out'
    this.disposePromptReadinessProbe()
    this.releaseDeviceAttributes()
    this.releaseHeldBytes()
    this.flushPreReadyQueue()
  }

  private onShellPromptReady(): void {
    if (this._state !== 'pending') {
      return
    }
    // Same sink as the timeout above: console goes nowhere in the detached daemon.
    this.reportReadiness('shell-ready-wrapper-replaced', {})
    this.releaseHeldBytes()
    this.transitionToReady(true, 'probe_prompt')
    this.releaseDeviceAttributes()
  }

  /** One launch-stage report per stage, on its own sink (the daemon log plus the
   *  relay to the attached client). Diagnostics only: no state, no writes, no
   *  effect on hook status, startup delivery or tui-idle. */
  private reportLaunchStage(
    stage: DaemonLaunchStageName,
    outcome: string,
    queuedWrites?: number
  ): void {
    if (this.reportedLaunchStages.has(stage)) {
      return
    }
    this.reportedLaunchStages.add(stage)
    try {
      this.deps.reportLaunchStage?.(this.deps.sessionId, {
        stage,
        outcome,
        elapsedMs: Math.max(0, Date.now() - this.armedAtMs),
        ...(queuedWrites === undefined ? {} : { queuedWrites })
      })
    } catch {
      // Why swallow: same rule as reportReadiness -- this runs on the path that
      // releases held bytes and flushes queued stdin, and diagnostics must never
      // strand the barrier or drop a startup command.
    }
  }

  private flushPreReadyQueue(): void {
    const queued = this.preReadyStdinQueue
    this.preReadyStdinQueue = []
    // Report before the writes so a throwing diagnostics sink cannot reorder or
    // drop the flush (reportReadiness swallows, and the state is already settled).
    if (queued.length > 0) {
      this.reportLaunchStage(
        'startup_command',
        this._state === 'timed_out' ? 'flushed_after_timeout' : 'flushed_after_ready',
        queued.length
      )
    }
    for (const data of queued) {
      this.deps.subprocess.write(data)
    }
  }
}
