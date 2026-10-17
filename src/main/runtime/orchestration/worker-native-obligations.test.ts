import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import type { ExactWorkerProviderSession } from '../../../shared/orchestration-worker-output'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { OrchestrationDb } from './db'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'
import { workerHasNativeObligations } from './worker-native-obligations'

const resource = {
  owner_dispatch_id: 'dispatch',
  terminal_handle: 'term_worker',
  pane_key: 'tab:leaf',
  process_incarnation: 'runtime:pty:1'
} as WorkerTerminalResourceRow
const session: ExactWorkerProviderSession = {
  paneKey: resource.pane_key!,
  processIncarnation: resource.process_incarnation!,
  agent: 'codex',
  providerSession: { key: 'session_id', id: 'native-parent' },
  observedAt: 1
}

function pending(
  hook: Partial<AgentStatusIpcPayload>,
  exact: ExactWorkerProviderSession | null = session
): boolean {
  const runtime = {
    getExactWorkerProviderSession: () => exact,
    getLastAgentHookRowForPane: () => ({ providerSession: session.providerSession, ...hook })
  } as unknown as OrcaRuntimeService
  const db = {
    getWorkerDispatch: () => ({ created_at: '2026-10-07 12:00:00' })
  } as unknown as OrchestrationDb
  return workerHasNativeObligations(runtime, db, resource)
}

describe('native child obligations before worker release', () => {
  it.each(['working', 'waiting', 'blocked'] as const)(
    'keeps the exact parent while a native child is %s',
    (state) => {
      expect(pending({ subagents: [{ id: 'child', startedAt: 1, state }] })).toBe(true)
      expect(pending({ subagents: [{ id: 'child', startedAt: 1, state: 'idle' }] })).toBe(false)
    }
  )

  it('keeps monitoring and background work even when a provider omits its child roster', () => {
    expect(pending({ workingMode: 'monitoring' })).toBe(true)
    expect(pending({ backgroundTaskCount: 1 })).toBe(true)
    expect(pending({ backgroundTaskCount: 0 })).toBe(false)
  })

  it.each(['waiting', 'blocked'] as const)(
    'keeps a worker that is %s on a person after its result was accepted',
    (state) => {
      expect(pending({ state })).toBe(true)
      expect(pending({ state: 'done' })).toBe(false)
    }
  )

  it('keeps a worker showing an unanswered native question or approval prompt', () => {
    const interactivePrompt = JSON.stringify({ questions: [{ question: 'Ship it?' }] })
    // A prompt that arrives between acceptance and the deferred cleanup retry still holds.
    expect(pending({ state: 'working', interactivePrompt })).toBe(true)
    expect(pending({ state: 'done', interactivePrompt })).toBe(true)
    expect(pending({ state: 'done', interactivePrompt: undefined })).toBe(false)
  })

  it('does not infer child completion from missing or mismatched parent identity', () => {
    expect(pending({}, null)).toBe(true)
    expect(pending({}, { ...session, paneKey: 'other:leaf' })).toBe(true)
    expect(pending({}, { ...session, processIncarnation: 'runtime:pty:2' })).toBe(true)
    expect(pending({ providerSession: { key: 'session_id', id: 'other-parent' } })).toBe(true)
  })
})
