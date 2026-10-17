/** Fakes for `FreshPaneEvidence`: hook events and typed input fed by hand, a settable epoch. */

import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { ConversationSource } from '../../shared/conversation-source'
import type { ConversationInvalidationReason } from '../runtime/conversation-write-fence'
import { FreshPaneEvidence } from './fresh-pane-evidence'
import { FreshPaneEvidenceStore } from './fresh-pane-evidence-store'

type WriteListener = (
  changed: (source: ConversationSource) => boolean,
  reason: ConversationInvalidationReason
) => void

export function hookEvent(
  overrides: Partial<AgentHookEventPayload> & { prompt?: string } = {}
): AgentHookEventPayload {
  const { prompt = '', ...rest } = overrides
  return {
    paneKey: 'tab-1:leaf-1',
    connectionId: null,
    worktreeId: 'wt-1',
    hookEventName: 'SessionStart',
    sessionStartSource: 'startup',
    providerSession: { key: 'claude', id: 's1', transcriptPath: '/t/s1.jsonl' },
    payload: { state: 'done', prompt, agentType: 'claude' },
    ...rest
  } as AgentHookEventPayload
}

/** A hydrated last-status row that is still Claude's empty SessionStart report. */
export function startRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: 'tab-1:leaf-1',
    connectionId: null,
    worktreeId: 'wt-1',
    receivedAt: 500,
    stateStartedAt: 500,
    agentPid: 4242,
    providerSession: { key: 'session_id', id: 's1', transcriptPath: '/t/s1.jsonl' },
    state: 'done',
    prompt: '',
    agentType: 'claude',
    sessionBoundary: true,
    ...overrides
  } as AgentStatusIpcPayload
}

export function freshPanes(
  options: {
    now?: number
    store?: string
    rows?: AgentStatusIpcPayload[]
    drained?: boolean
    /** Wire SSH connection epochs, so events with a connection id are heard. */
    ssh?: boolean
  } = {}
) {
  const hooks = new Set<(event: AgentHookEventPayload) => void>()
  const writes = new Set<WriteListener>()
  const lost = new Set<() => void>()
  const clock = {
    now: options.now ?? 1_000,
    epoch: 1,
    spooled: false,
    drained: options.drained ?? false,
    connections: {} as Record<string, number>
  }
  const evidence = new FreshPaneEvidence({
    subscribeHookEvents: (listener) => {
      hooks.add(listener)
      return () => hooks.delete(listener)
    },
    subscribeWrites: (listener) => {
      writes.add(listener)
      return () => writes.delete(listener)
    },
    subscribeLost: (listener) => {
      lost.add(listener)
      return () => lost.delete(listener)
    },
    continuityEpoch: () => clock.epoch,
    spooledSince: () => clock.spooled,
    drainedSince: () => clock.drained,
    ...(options.ssh ? { connectionEpoch: (id: string) => clock.connections[id] ?? 0 } : {}),
    ...(options.store
      ? {
          store: new FreshPaneEvidenceStore(options.store, () => clock.now),
          hydratedRows: () => options.rows ?? []
        }
      : {}),
    now: () => clock.now
  })
  return {
    evidence,
    clock,
    hook: (event: AgentHookEventPayload) => hooks.forEach((listener) => listener(event)),
    write: (paneKey: string, reason: ConversationInvalidationReason = 'input') =>
      writes.forEach((listener) => listener((source) => source.paneKey === paneKey, reason)),
    lose: () => lost.forEach((listener) => listener())
  }
}
