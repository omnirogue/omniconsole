/**
 * A relay for owner-service tests: the real account registry and admission (package A) on a
 * temporary directory, the real relay executor, and fakes only for what the relay daemon holds:
 * its PTYs, the agents' hook reports, the foreground process and the bytes written.
 */

import { join } from 'node:path'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { SessionHostProcess } from '../main/session-host/session-host-process'
import { testHostProcess } from '../main/session-host/session-host-test-fixture'
import { HostWaitRegistry } from '../main/session-host-owner/host-wait-registry'
import type { RelayOwnerPane } from './pty-handler'
import { RelaySessionHostExecutor } from './relay-owner-executor'
import { relayTransferHostActions, type RelayRelocationDeps } from './relay-owner-relocation'
import type { RelayOwnerFacts } from './relay-owner-sessions'
import { RelayTurnLedger } from './relay-owner-turns'

export const RELAY_PANE = 'tab-9:leaf-1'
export const RELAY_WORKTREE = 'repo::/srv/app'
export const RELAY_SESSION = 'claude-remote-1'

export function hookReport(
  state: AgentHookEventPayload['payload']['state'],
  extra: Partial<AgentHookEventPayload> = {}
): AgentHookEventPayload {
  return {
    paneKey: RELAY_PANE,
    worktreeId: RELAY_WORKTREE,
    connectionId: null,
    providerSession: { key: 'session_id', id: RELAY_SESSION },
    payload: { state, prompt: '', agentType: 'claude', lastAssistantMessage: 'All done.' },
    ...extra
  }
}

export type RelayTestHost = {
  process: SessionHostProcess
  facts: RelayOwnerFacts
  executor: RelaySessionHostExecutor
  turns: RelayTurnLedger
  panes: RelayOwnerPane[]
  reports: Map<string, AgentHookEventPayload>
  foreground: { current: string | null }
  written: { ptyId: string; data: string }[]
  exited: Map<string, number>
  clock: { now: number }
  waits: HostWaitRegistry
  /** An agent report, as the hook server applies it. */
  report(event: AgentHookEventPayload): void
}

export function relayTestHost(input: {
  root: string
  incarnation?: string
  dead?: string[]
  /** Installs package C's relocation steps over these process facts (package B3). */
  relocation?: Pick<RelayRelocationDeps, 'agentEvidence' | 'homeDir'>
}): RelayTestHost {
  const clock = { now: 1_000_000 }
  const turns = new RelayTurnLedger(input.incarnation ?? 'relay-1', () => clock.now)
  const panes: RelayOwnerPane[] = [
    { ptyId: 'pty-9', paneKey: RELAY_PANE, tabId: 'tab-9', worktreeId: RELAY_WORKTREE, alive: true }
  ]
  const reports = new Map<string, AgentHookEventPayload>()
  const foreground = { current: 'claude' as string | null }
  const written: RelayTestHost['written'] = []
  const exited = new Map<string, number>()
  const facts: RelayOwnerFacts = {
    panes: () => panes,
    status: (paneKey) => reports.get(paneKey) ?? null,
    exitedAt: (paneKey) => exited.get(paneKey) ?? null,
    foreground: async () => foreground.current,
    write: (ptyId, data) => {
      if (!panes.some((pane) => pane.ptyId === ptyId)) {
        return false
      }
      written.push({ ptyId, data })
      return true
    },
    now: () => clock.now
  }
  const waits = new HostWaitRegistry(join(input.root, 'relay-waits.json'), () => clock.now)
  let process: SessionHostProcess
  const relocation = input.relocation
    ? relayTransferHostActions({
        facts,
        turns,
        ...input.relocation,
        userDataPath: join(input.root, 'relay-data'),
        store: () => process.current()?.store ?? null
      })
    : null
  const executor = new RelaySessionHostExecutor({
    facts,
    turns,
    sleep: async () => {},
    newId: () => '0123456789abcdef',
    waits,
    readWaitResult: (dependency, since) => {
      const registration = process.current()?.store.snapshot()?.conversations[dependency]
      const paneKey = registration?.binding?.paneKey
      const turn = paneKey ? turns.latestFor(paneKey) : null
      const revision = paneKey ? turns.revision(paneKey) : null
      return registration && turn && revision && turn.at > since
        ? { ownerEpoch: registration.ownerEpoch, outcomeRevision: revision, at: turn.at }
        : null
    },
    reconciled: () => true,
    ...(relocation ? { actionHandlers: [relocation] } : {})
  })
  process = testHostProcess({
    root: input.root,
    incarnation: input.incarnation ?? 'relay-1',
    kind: 'ssh-relay',
    executor,
    ...(input.dead ? { dead: input.dead } : {})
  })
  return {
    process,
    facts,
    executor,
    turns,
    panes,
    reports,
    foreground,
    written,
    exited,
    clock,
    waits,
    report: (event) => {
      reports.set(event.paneKey, event)
      turns.apply(event)
    }
  }
}
