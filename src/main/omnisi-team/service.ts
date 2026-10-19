import { TeamConfigTargets } from './config-targets'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { OmnisiTeamStatus } from '../../shared/omnisi-team'
import { ConnectorService } from '../mcp/connector-service'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { parseTeamConnection, type TeamConnection, TeamConnectionStore } from './connection'
import { TeamMcpClient } from './mcp-client'
import { setTeamLaunchConnection } from './launch'
import { TeamBridge } from './bridge'
import {
  assertTeamPaneReady,
  deliverTeamDirective,
  readTeamPanes,
  teamReceiptKey
} from './runtime-panes'

type Receipt = { operation: string; delivered: boolean }
export class OmnisiTeamService {
  private readonly credentials: TeamConnectionStore
  private readonly connectors: ConnectorService
  private readonly targets: TeamConfigTargets
  private connection: TeamConnection | null = null
  private bridge: TeamBridge | null = null
  private client: TeamMcpClient | null = null
  private error: string | undefined
  private serial: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null
  private receipts: Record<string, Receipt> = {}
  constructor(
    private readonly directory: string,
    private readonly store: Store,
    private readonly runtime: OrcaRuntimeService
  ) {
    this.credentials = new TeamConnectionStore(join(directory, 'connection.sealed'))
    this.targets = new TeamConfigTargets(join(directory, 'config-targets.json'))
    this.connectors = new ConnectorService(() => store.getSettings())
  }
  status(): OmnisiTeamStatus {
    return {
      enabled: this.store.getSettings().experimentalOmnisiTeam === true,
      connected: this.connection !== null,
      ...(this.connection ? { server: this.connection.server, team: this.connection.team } : {}),
      ...(this.error ? { error: this.error } : {})
    }
  }
  start(): Promise<OmnisiTeamStatus> {
    return this.exclusive(async () => {
      if (this.store.getSettings().experimentalOmnisiTeam !== true) {
        return
      }
      try {
        const saved = this.credentials.read()
        if (saved) {
          if ((await this.verify(saved)) !== saved.team) {
            throw new Error('The saved OmniSI team identity changed. Connect again.')
          }
          await this.connectors.syncOmnisiTeam(saved.server, (target) =>
            this.targets.remember(target)
          )
          this.activate(saved)
        }
      } catch {
        this.report('OmniSI could not reconnect. Unlock your OS keychain and check your team key.')
      }
    })
  }
  enable(enabled: boolean): Promise<OmnisiTeamStatus> {
    return this.exclusive(async () => {
      if (typeof enabled !== 'boolean') {
        throw new Error('Choose whether to enable the experiment.')
      }
      if (!enabled) {
        await this.clear()
      }
      this.store.updateSettings({ experimentalOmnisiTeam: enabled })
    })
  }
  connect(server: string, key: string): Promise<OmnisiTeamStatus> {
    return this.exclusive(async () => {
      if (this.store.getSettings().experimentalOmnisiTeam !== true) {
        throw new Error('Enable OmniSI team first.')
      }
      if (this.connection) {
        throw new Error('Disconnect the current team before connecting another.')
      }
      const parsed = parseTeamConnection(server, key)
      const team = await this.verify(parsed)
      // Seal before configuring providers; a failed setup remains disconnectable after restart.
      const saved = this.credentials.save({ ...parsed, team })
      try {
        await this.connectors.syncOmnisiTeam(saved.server, (target) =>
          this.targets.remember(target)
        )
        this.activate(saved)
      } catch {
        this.report(
          'OmniSI setup did not finish. Disconnect to remove the partial connector configuration, then try again.'
        )
        throw new Error(this.error)
      }
    })
  }
  disconnect(): Promise<OmnisiTeamStatus> {
    return this.exclusive(() => this.clear())
  }
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.timer = null
    setTeamLaunchConnection(null)
    await this.bridge?.stop()
    this.bridge = null
    await this.client?.close()
    this.client = null
  }
  private async clear(): Promise<void> {
    await this.stop()
    this.connection = null
    // Keep the sealed key if cleanup fails, so Disconnect can be retried.
    if (existsSync(join(this.directory, 'connection.sealed'))) {
      await this.connectors.syncOmnisiTeam(null)
    }
    this.targets.clear()
    this.credentials.remove()
    this.error = undefined
  }
  private async verify(value: { server: string; key: string }): Promise<string> {
    const client = new TeamMcpClient(value.server, value.key)
    const identity = await client.call('whoami', {}).finally(() => client.close())
    if (typeof identity.org_id !== 'string' || !identity.org_id) {
      throw new Error('OmniSI did not return a verified team.')
    }
    return identity.org_id
  }
  private activate(value: TeamConnection): void {
    const file = join(this.directory, 'delivery-receipts.json')
    this.receipts = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    this.connection = value
    this.error = undefined
    setTeamLaunchConnection(value, (target) => this.targets.remember(target))
    this.client = new TeamMcpClient(value.server, value.key)
    this.bridge = new TeamBridge(
      value,
      this.client,
      (pane, text, operation, signal) =>
        deliverTeamDirective(this.runtime, pane, text, operation, signal),
      {
        read: (id) => this.receipts[teamReceiptKey(id)],
        save: (id, receipt) => {
          this.receipts[teamReceiptKey(id)] = { ...receipt }
          mkdirSync(this.directory, { recursive: true, mode: 0o700 })
          writeFileAtomically(file, JSON.stringify(this.receipts), { mode: 0o600 })
        }
      },
      (message) => this.report(message),
      (pane) => assertTeamPaneReady(this.runtime, pane)
    )
    const reconcile = (): void => {
      try {
        this.bridge?.reconcile(readTeamPanes(this.runtime))
      } catch {
        this.report('OmniSI could not verify the open AI panes. Delivery is paused.')
      }
    }
    reconcile()
    this.timer = setInterval(reconcile, 5000)
    this.timer.unref()
  }
  private report(message: string): void {
    this.error = message
    console.warn('[omnisi-team]', message)
  }
  private exclusive(work: () => Promise<void>): Promise<OmnisiTeamStatus> {
    const next = this.serial.then(async () => {
      await work()
      return this.status()
    })
    this.serial = next.catch(() => {})
    return next
  }
}
