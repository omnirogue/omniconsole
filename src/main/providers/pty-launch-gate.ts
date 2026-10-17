import { randomUUID } from 'node:crypto'
import {
  isPtyLaunchGateRequest,
  isPtyLaunchGateReceipt,
  type PtyLaunchGateRequest,
  type PtyLaunchGateReceipt,
  type PtyLaunchGateRelease,
  type PtyLaunchGateReleased,
  type PtyLaunchGateObservation
} from '../../shared/pty-launch-gate'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'
import { buildPtyLaunchGateCommand } from './pty-launch-gate-command'
import { resolveMacosPtyProcessObserver } from './macos-pty-process-observer-path'
import {
  armMacosPtyProcessObserver,
  type MacosPtyProcessObserver
} from './macos-pty-process-observer'
import { waitForLaunchGateShellIdentity } from './pty-launch-gate-shell-identity'

const MAX_HELD_INPUT = 1024 * 1024

export function assertNativeLaunchGateRequest(request: unknown, command: unknown): void {
  if (!isPtyLaunchGateRequest(request) || typeof command !== 'string' || !command.trim()) {
    throw new Error('pty_launch_gate_request_invalid')
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('pty_launch_gate_unavailable')
  }
  buildPtyLaunchGateCommand(command, request)
  if (request.processObservation && !resolveMacosPtyProcessObserver()) {
    throw new Error('pty_launch_gate_exit_observer_unavailable')
  }
}

/** Owns input admission only; canonical start persistence remains the caller's responsibility. */
export class PtyLaunchGate {
  private readonly gateId = randomUUID()
  private receipt: PtyLaunchGateReceipt | null = null
  private released: PtyLaunchGateReleased | null = null
  private stopped = false
  private input: string[] = []
  private inputLength = 0
  private startupInput: string | null = null
  private startupReady = false
  private startupFlushed = false
  private observer: MacosPtyProcessObserver | undefined
  private observationPreparation: Promise<MacosPtyProcessObserver> | undefined

  constructor(
    private readonly deps: {
      request: PtyLaunchGateRequest
      command: string
      ptyId: string
      incarnationId: string
      pid: number
      reportsChildExitStatus: boolean
      isLive: () => boolean
      write: (data: string) => void
      readBirth?: (pid: number) => Promise<number | null>
      shellOwner?: object
      shellPath?: string
    }
  ) {}

  write = (data: string): void => {
    if (this.stopped || !this.deps.isLive()) {
      return
    }
    if (!this.startupReady && data === this.startupInput) {
      this.startupReady = true
      this.flush()
      return
    }
    if (this.released && this.startupFlushed) {
      this.deps.write(data)
      return
    }
    if (this.inputLength + data.length > MAX_HELD_INPUT) {
      this.close()
      throw new Error('pty_launch_gate_input_limit')
    }
    this.input.push(data)
    this.inputLength += data.length
  }

  expectStartup(data: string): void {
    if (this.startupInput !== null && this.startupInput !== data) {
      throw new Error('pty_launch_gate_startup_conflict')
    }
    this.startupInput = data
  }

  submitStartup = (data: string): void => {
    this.expectStartup(data)
    this.write(data)
  }

  async prepare(
    request = this.deps.request,
    command = this.deps.command
  ): Promise<PtyLaunchGateReceipt> {
    if (
      request.launchId !== this.deps.request.launchId ||
      request.version !== 1 ||
      request.startupCommandMode !== this.deps.request.startupCommandMode ||
      request.processObservation !== this.deps.request.processObservation ||
      command !== this.deps.command
    ) {
      throw new Error('pty_launch_gate_conflict')
    }
    const birth = await (this.deps.readBirth ?? readProcessStartTimeMs)(this.deps.pid).catch(
      () => null
    )
    if (this.stopped || this.released || !this.deps.isLive()) {
      throw new Error('pty_launch_gate_not_closed')
    }
    if (!Number.isSafeInteger(birth) || (birth as number) <= 0) {
      throw new Error('pty_launch_gate_birth_unverifiable')
    }
    const observer = request.processObservation ? await this.prepareObservation() : undefined
    if (observer) {
      await observer.verifyHeld()
    }
    if (this.stopped || this.released || !this.deps.isLive()) {
      throw new Error('pty_launch_gate_not_closed')
    }
    if (
      observer &&
      Math.floor(observer.identity.ptyRootProcessStartTimeMs / 1000) * 1000 !== birth
    ) {
      throw new Error('pty_launch_gate_identity_mismatch')
    }
    if (this.receipt && !observer && this.receipt.processStartTimeMs !== birth) {
      throw new Error('pty_launch_gate_identity_mismatch')
    }
    this.receipt ??= {
      version: 1,
      state: 'closed',
      launchId: request.launchId,
      gateId: this.gateId,
      ptyId: this.deps.ptyId,
      incarnationId: this.deps.incarnationId,
      pid: this.deps.pid,
      processStartTimeMs: birth as number,
      processKind: 'pty-root',
      reportsChildExitStatus: this.deps.reportsChildExitStatus,
      startupCommandMode:
        this.deps.reportsChildExitStatus && request.startupCommandMode === 'exec'
          ? 'exec'
          : 'shell',
      ...(observer
        ? {
            ...observer.identity,
            processKind: 'pty-shell' as const,
            startupCommandMode: 'exec' as const,
            reportsChildExitStatus: true,
            exitObserver: 'macos-kqueue' as const
          }
        : {})
    }
    if (!isPtyLaunchGateReceipt(this.receipt)) {
      throw new Error('pty_launch_gate_identity_unverifiable')
    }
    return { ...this.receipt }
  }

  async release(request: PtyLaunchGateRelease): Promise<PtyLaunchGateReleased> {
    if (
      !isPtyLaunchGateReceipt(request?.gate) ||
      !this.receipt ||
      Object.entries(this.receipt).some(
        ([key, value]) => request.gate[key as keyof PtyLaunchGateReceipt] !== value
      )
    ) {
      throw new Error('pty_launch_gate_identity_mismatch')
    }
    if (
      typeof request.startAcknowledgement !== 'string' ||
      !request.startAcknowledgement.trim() ||
      request.startAcknowledgement.length > 4096
    ) {
      throw new Error('pty_launch_gate_start_acknowledgement_required')
    }
    if (this.released && this.released.startAcknowledgement !== request.startAcknowledgement) {
      throw new Error('pty_launch_gate_acknowledgement_conflict')
    }
    if (this.observer) {
      if (this.released) {
        if ((await this.observer.read()).state !== 'live') {
          throw new Error('pty_launch_gate_identity_unverifiable')
        }
      } else {
        await this.observer.verifyHeld()
      }
    } else {
      const birth = await (this.deps.readBirth ?? readProcessStartTimeMs)(this.deps.pid).catch(
        () => null
      )
      if (birth !== this.receipt.processStartTimeMs) {
        throw new Error('pty_launch_gate_identity_unverifiable')
      }
    }
    if (this.stopped || !this.deps.isLive()) {
      throw new Error('pty_launch_gate_identity_unverifiable')
    }
    if (this.released) {
      if (this.released.startAcknowledgement !== request.startAcknowledgement) {
        throw new Error('pty_launch_gate_acknowledgement_conflict')
      }
      return { ...this.released }
    }
    this.released = {
      gateId: this.gateId,
      state: 'released',
      startAcknowledgement: request.startAcknowledgement
    }
    this.flush()
    return { ...this.released }
  }

  private flush(): void {
    if (this.stopped || !this.released || !this.startupReady || this.startupFlushed) {
      return
    }
    // Readiness and admission may settle in either order; user input never overtakes startup.
    this.startupFlushed = true
    const input = [this.startupInput!, ...this.input]
    this.input = []
    this.inputLength = 0
    try {
      for (const data of input) {
        this.deps.write(data)
      }
    } catch (error) {
      // A partial write is never replayed as another launch.
      this.close()
      throw error
    }
  }

  close(): void {
    this.stopped = true
    this.input = []
    this.inputLength = 0
    this.startupInput = null
  }

  get retainsProcessObservation(): boolean {
    return this.deps.request.processObservation === 'required'
  }

  private prepareObservation(): Promise<MacosPtyProcessObserver> {
    this.observationPreparation ??= (async () => {
      if (!this.deps.shellOwner || !this.deps.shellPath) {
        throw new Error('pty_launch_gate_shell_identity_unavailable')
      }
      const shellPid = await waitForLaunchGateShellIdentity(this.deps.shellOwner)
      if (this.stopped || !this.deps.isLive()) {
        throw new Error('pty_launch_gate_not_closed')
      }
      this.observer = await armMacosPtyProcessObserver({
        rootPid: this.deps.pid,
        shellPid,
        shellPath: this.deps.shellPath
      })
      if (this.stopped || !this.deps.isLive()) {
        this.observer.dispose()
        throw new Error('pty_launch_gate_not_closed')
      }
      return this.observer
    })()
    return this.observationPreparation
  }

  async readObservation(gate: PtyLaunchGateReceipt): Promise<PtyLaunchGateObservation> {
    if (
      !this.receipt ||
      !isPtyLaunchGateReceipt(gate) ||
      Object.entries(this.receipt).some(
        ([key, value]) => gate[key as keyof PtyLaunchGateReceipt] !== value
      )
    ) {
      throw new Error('pty_launch_gate_identity_mismatch')
    }
    return {
      gateId: gate.gateId,
      ptyId: gate.ptyId,
      incarnationId: gate.incarnationId,
      pid: gate.pid,
      processStartTimeMs: gate.processStartTimeMs,
      startAcknowledgement: this.released?.startAcknowledgement ?? null,
      ...((await this.observer?.read()) ?? {
        state: 'unverifiable',
        reason: 'exit_observer_unavailable'
      })
    }
  }

  dispose(): void {
    this.close()
    this.observer?.dispose()
  }
}
