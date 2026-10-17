import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  createAutomationRun,
  updateAutomationRun,
  type AutomationRunOperations
} from './automation-run-operations'

const CODEX_HOME =
  '/Users/maintainer/Library/Application Support/omniconsole-ide/codex-accounts/acct/home'
const transcriptPath = `${CODEX_HOME}/sessions/2026/09/19/rollout-2026-09-19T16-30-57-thread-1.jsonl`

function operations(): AutomationRunOperations {
  const automation = { id: 'a', name: 'Ads', prompt: 'Review ads' } as Automation
  return {
    state: {
      repos: [],
      automations: [automation],
      automationRuns: []
    } as unknown as PersistedState,
    flush: vi.fn(),
    recordManualRun: vi.fn(),
    getWorkspaceDisplayName: () => null
  }
}

describe('updateAutomationRun provider session record', () => {
  it('keeps the thread id across a follow-up write and the completion write', () => {
    const ops = operations()
    const run = createAutomationRun(ops, ops.state.automations[0], 1, 'manual')
    const dispatched = updateAutomationRun(ops, {
      runId: run.id,
      status: 'dispatched',
      terminalPaneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      terminalPtyId: 'pty-1',
      error: null
    })
    const dispatchedAt = dispatched.dispatchedAt
    expect(dispatchedAt).not.toBeNull()

    const named = updateAutomationRun(ops, {
      runId: run.id,
      status: 'dispatched',
      providerSession: {
        providerSessionId: 'thread-1',
        providerSessionAgent: 'codex',
        providerSessionTranscriptPath: transcriptPath
      },
      resume: { requested: 'thread-0', outcome: 'resumed' }
    })
    expect(named).toMatchObject({
      providerSessionId: 'thread-1',
      providerSessionAgent: 'codex',
      providerSessionTranscriptPath: transcriptPath,
      providerSessionHome: CODEX_HOME,
      resume: { requested: 'thread-0', outcome: 'resumed' },
      terminalPtyId: 'pty-1'
    })
    // Why: the follow-up is still 'dispatched'; re-stamping would move the usage window.
    expect(named.dispatchedAt).toBe(dispatchedAt)

    const completed = updateAutomationRun(ops, { runId: run.id, status: 'completed', error: null })
    expect(completed).toMatchObject({
      status: 'completed',
      providerSessionId: 'thread-1',
      providerSessionAgent: 'codex',
      resume: { requested: 'thread-0', outcome: 'resumed' }
    })
  })

  it('drops a malformed thread record and clears on explicit null', () => {
    const ops = operations()
    const run = createAutomationRun(ops, ops.state.automations[0], 1, 'manual')
    const rejected = updateAutomationRun(ops, {
      runId: run.id,
      status: 'dispatched',
      providerSession: {
        providerSessionId: '--not-an-id',
        providerSessionAgent: 'codex'
      },
      error: null
    })
    expect(rejected.providerSessionId).toBeUndefined()
    expect('providerSessionId' in rejected).toBe(false)

    updateAutomationRun(ops, {
      runId: run.id,
      status: 'dispatched',
      providerSession: { providerSessionId: 'thread-2', providerSessionAgent: 'claude' },
      error: null
    })
    const cleared = updateAutomationRun(ops, {
      runId: run.id,
      status: 'completed',
      providerSession: null,
      error: null
    })
    expect('providerSessionId' in cleared).toBe(false)
    expect('providerSessionAgent' in cleared).toBe(false)
  })
})
