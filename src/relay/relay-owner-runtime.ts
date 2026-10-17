/**
 * Starts the owner service on this SSH relay: installs the relay executor on its session host
 * process (so the relay advertises control on `pty.getCapabilities`), keeps the account registry in
 * step with its panes, and settles what a previous relay left unknown. No window, no Mac needed.
 * Package C's relocation steps are installed with it, so a conversation here can move to a Mac.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { SessionHostProcess } from '../main/session-host/session-host-process'
import {
  HostWaitRegistry,
  type HostWaitResultReader
} from '../main/session-host-owner/host-wait-registry'
import { remoteControlsOn } from '../main/session-host-owner/session-host-switches'
import type { PtyHandler } from './pty-handler'
import { adoptRelaySessions, reconcileRelayDeliveries } from './relay-owner-adoption'
import { RelaySessionHostExecutor } from './relay-owner-executor'
import { relayTransferHostActions } from './relay-owner-relocation'
import type { RelayOwnerFacts } from './relay-owner-sessions'
import type { RelayTurnLedger } from './relay-owner-turns'
import { relayLogLine } from './relay-diagnostic-log'

const FIRST_PASS_MS = 5_000
const PASS_EVERY_MS = 60_000

export function startRelaySessionHostOwner(input: {
  process: SessionHostProcess
  ptyHandler: Pick<
    PtyHandler,
    'ownerPanes' | 'writeFromHost' | 'foregroundProcessOf' | 'onOwnerPaneExit' | 'agentEvidenceOf'
  >
  paneStatus(paneKey: string): AgentHookEventPayload | null
  turns: RelayTurnLedger
  waitsFile?: string
}): () => Promise<void> {
  const { process, ptyHandler, turns } = input
  const exited = new Map<string, number>()
  const stopExits = ptyHandler.onOwnerPaneExit(({ paneKey }) => {
    if (paneKey) {
      exited.set(paneKey, Date.now())
      turns.forget(paneKey)
    }
  })
  const facts: RelayOwnerFacts = {
    panes: () => ptyHandler.ownerPanes(),
    status: (paneKey) => input.paneStatus(paneKey),
    exitedAt: (paneKey) => exited.get(paneKey) ?? null,
    foreground: (ptyId) => ptyHandler.foregroundProcessOf(ptyId),
    write: (ptyId, data) => ptyHandler.writeFromHost(ptyId, data),
    now: () => Date.now()
  }
  const waits = new HostWaitRegistry(
    input.waitsFile ?? join(homedir(), '.omni-relay', 'session-host', 'waits.json')
  )
  const readWaitResult: HostWaitResultReader = (dependency, since) => {
    const registration = process.current()?.store.snapshot()?.conversations[dependency]
    const paneKey = registration?.binding?.paneKey
    const turn = paneKey ? turns.latestFor(paneKey) : null
    const revision = paneKey ? turns.revision(paneKey) : null
    return registration && turn && revision && turn.at > since
      ? { ownerEpoch: registration.ownerEpoch, outcomeRevision: revision, at: turn.at }
      : null
  }
  const transfers = relayTransferHostActions({
    facts,
    turns,
    agentEvidence: (ptyId) => ptyHandler.agentEvidenceOf(ptyId),
    store: () => process.current()?.store ?? null
  })
  let reconciled = false
  process.installExecutor(
    new RelaySessionHostExecutor({
      facts,
      turns,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      newId: () => randomUUID(),
      waits,
      readWaitResult,
      reconciled: () => reconciled,
      actionHandlers: [transfers]
    })
  )
  let stopped = false
  let passing: Promise<void> = Promise.resolve()
  const pass = async (): Promise<void> => {
    if (stopped || !remoteControlsOn()) {
      return
    }
    const service = await process.service()
    await reconcileRelayDeliveries({ store: service.store, turns })
    await transfers.reconcile()
    reconciled = true
    await adoptRelaySessions({ store: service.store, facts, turns })
    await waits.refresh(readWaitResult)
  }
  const run = () => {
    passing = passing
      .then(pass)
      .catch((error: unknown) =>
        relayLogLine(
          `[relay] session host owner pass failed: ${error instanceof Error ? error.message : String(error)}`
        )
      )
  }
  const first = setTimeout(run, FIRST_PASS_MS)
  const interval = setInterval(run, PASS_EVERY_MS)
  first.unref?.()
  interval.unref?.()
  return async () => {
    stopped = true
    stopExits()
    clearTimeout(first)
    clearInterval(interval)
    await passing
    await waits.flush().catch(() => {})
  }
}
