/**
 * One per host process (a paired runtime or a relay daemon): its executor, and its lazily opened
 * handle on the account's registry. Opening records this process as a live controller and
 * reconciles what provably dead ones left in flight. Nothing opens (or creates) the registry until
 * an executor is installed, a remote call passes the gate, or a registry already exists.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionHostCapability } from '../../shared/session-host-capabilities'
import type { SessionHostIdentity } from '../../shared/session-host-identity'
import { SessionHostAdmissionStore } from './session-host-admission-store'
import {
  advertisableSessionHostCapabilities,
  UNSUPPORTED_SESSION_HOST_EXECUTOR,
  type SessionHostExecutor
} from './session-host-executor'
import { SessionHostJournalFile, SessionHostStorageError } from './session-host-journal-file'
import type { SessionHostControllerKind } from './session-host-journal'
import {
  defaultSessionHostProcessLiveness,
  openSessionHostController,
  readSessionHostProcessIdentity,
  type SessionHostProcessLiveness
} from './session-host-reconcile'
import {
  readSessionHostMachineIdentity,
  sessionHostRegistryMayExist,
  sessionHostRegistryRoot
} from './session-host-registry-location'
import { SessionHostService } from './session-host-service'

export type SessionHostProcessOptions = {
  kind: SessionHostControllerKind
  /** The runtime's `runtimeId`, or a relay daemon's start id; a change forces renegotiation. */
  incarnation: string
  /** Tests point it at a temporary directory; otherwise derived from the machine and OS user. */
  root?: string
  home?: string
  liveness?: SessionHostProcessLiveness
  processIdentity?: () => Promise<string | null>
  now?: () => number
}

/** What the remote gate needs from a host process. */
export type SessionHostGateHost = {
  capabilities(): SessionHostCapability[]
  service(): Promise<SessionHostService>
}

export class SessionHostProcess implements SessionHostGateHost {
  private executor: SessionHostExecutor = UNSUPPORTED_SESSION_HOST_EXECUTOR
  private opening: Promise<SessionHostService> | null = null
  private opened: SessionHostService | null = null

  constructor(readonly options: SessionHostProcessOptions) {}

  /** Package B installs its owner service here; C and D extend it. */
  installExecutor(executor: SessionHostExecutor): void {
    this.executor = executor
  }

  capabilities(): SessionHostCapability[] {
    return advertisableSessionHostCapabilities(this.executor)
  }

  current(): SessionHostService | null {
    return this.opened
  }

  service(): Promise<SessionHostService> {
    this.opening ??= this.open().then(
      (service) => (this.opened = service),
      (error: unknown) => {
        // Why reset: a transient lock or disk failure must not disable host control until restart.
        this.opening = null
        throw error
      }
    )
    return this.opening
  }

  /** Opens only a registry that already exists: a lookup never creates one. */
  async serviceIfPresent(): Promise<SessionHostService | null> {
    if (this.opened) {
      return this.opened
    }
    if (!this.options.root && !sessionHostRegistryMayExist(this.options.home)) {
      return null
    }
    const root = await this.root()
    return existsSync(join(root, 'registry.json')) ? await this.service() : null
  }

  /** Sync, for capability probes: only once open, and only what the executor can carry out. */
  advertisement(): { capabilities: SessionHostCapability[]; identity: SessionHostIdentity } | null {
    const capabilities = this.capabilities()
    return this.opened && capabilities.length > 0
      ? { capabilities, identity: this.opened.identity }
      : null
  }

  private async root(): Promise<string> {
    if (this.options.root) {
      return this.options.root
    }
    const machine = await readSessionHostMachineIdentity()
    if (!machine) {
      throw new SessionHostStorageError(
        'This computer cannot identify itself durably, so it cannot own sessions for other computers.'
      )
    }
    return sessionHostRegistryRoot(machine, this.options.home)
  }

  private async open(): Promise<SessionHostService> {
    const now = this.options.now ?? Date.now
    const file = new SessionHostJournalFile(await this.root())
    const hostId = await file.readOrMintHostId()
    const store = new SessionHostAdmissionStore(
      file,
      { hostId, incarnation: this.options.incarnation },
      now
    )
    await openSessionHostController(
      store,
      {
        incarnation: this.options.incarnation,
        kind: this.options.kind,
        pid: process.pid,
        processIdentity: await (
          this.options.processIdentity ?? (() => readSessionHostProcessIdentity(process.pid))
        )(),
        startedAt: now()
      },
      this.options.liveness ?? defaultSessionHostProcessLiveness
    )
    return new SessionHostService(store, () => this.executor)
  }
}
