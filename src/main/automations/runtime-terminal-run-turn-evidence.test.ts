import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../shared/automations-types'
import {
  readCurrentAutomationRunTurnEnd,
  type AutomationRunHookEvidence
} from './runtime-terminal-run-turn-evidence'

const NOW = 1_800_000_000_000

function fixture() {
  const run: AutomationRun = {
    id: 'run-1',
    automationId: 'routine-1',
    title: 'Report',
    scheduledFor: NOW - 1_000,
    status: 'dispatched',
    trigger: 'scheduled',
    workspaceId: 'wt',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab',
    terminalPaneKey: 'pane',
    terminalPtyId: 'pty',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: NOW - 1_000,
    dispatchedAt: NOW - 1_000,
    createdAt: NOW - 1_000,
    providerSessionId: 'provider-1',
    providerSessionAgent: 'claude',
    terminalProcessIncarnation: 'pty:inc-1'
  }
  const hook: AutomationRunHookEvidence = {
    state: 'done',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'provider-1' },
    stateStartedAt: NOW - 100,
    updatedAt: NOW,
    onAttachedPty: true,
    observation: {
      origin: 'hook',
      kind: 'transition',
      authorityId: 'runtime-2',
      incarnation: 2,
      revision: 3,
      observedAt: NOW
    }
  }
  let ptyId = 'pty'
  let paneHandle = 'handle'
  const runtime = {
    getTerminalHandleForPaneKey: () => paneHandle,
    getFreshAgentHookStatusForHandle: () => hook,
    getTerminalProcessIncarnation: () => 'pty:inc-1',
    showTerminal: vi.fn(async () => ({ ptyId }))
  }
  const readSnapshot = vi.fn(async () => null)
  const read = () =>
    readCurrentAutomationRunTurnEnd({
      runtime,
      handle: 'handle',
      readCurrentRun: () => run,
      readSnapshot
    })
  return {
    run,
    hook,
    runtime,
    readSnapshot,
    read,
    replacePty: () => {
      ptyId = 'replacement'
    },
    replaceHandle: () => {
      paneHandle = 'replacement'
    }
  }
}

describe('native dispatched-turn recovery evidence', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW))
  afterEach(() => vi.restoreAllMocks())

  it('recovers the exact current native completion without another working edge', async () => {
    expect(await fixture().read()).toEqual({
      status: 'completed',
      outputSnapshot: null,
      error: null
    })
  })

  it.each(['failed', 'interrupted'] as const)(
    'preserves current native %s semantics',
    async (field) => {
      const f = fixture()
      f.hook[field] = true
      expect(await f.read()).toMatchObject({ status: 'dispatch_failed' })
    }
  )

  it.each([
    'old-turn',
    'future-start',
    'future-update',
    'missing-start',
    'invalid-update',
    'missing-provenance',
    'snapshot',
    'identity-only',
    'osc',
    'boundary',
    'session-boundary',
    'provider-only',
    'different-provider',
    'different-agent',
    'missing-provider',
    'detached',
    'replaced-pty',
    'replaced-handle',
    'already-final',
    'missing-incarnation',
    'wrong-key'
  ])('does not settle unproven evidence: %s', async (variant) => {
    const f = fixture()
    switch (variant) {
      case 'old-turn':
        f.hook.stateStartedAt = f.run.dispatchedAt! - 1
        f.hook.failed = true
        break
      case 'future-start':
        f.hook.stateStartedAt = NOW + 1
        break
      case 'future-update':
        f.hook.updatedAt = NOW + 1
        break
      case 'missing-start':
        delete f.hook.stateStartedAt
        break
      case 'invalid-update':
        f.hook.updatedAt = Number.NaN
        break
      case 'missing-provenance':
        delete f.hook.observation
        break
      case 'snapshot':
        f.hook.observation!.kind = 'snapshot'
        break
      case 'identity-only':
        f.hook.observation!.kind = 'identity-only'
        break
      case 'osc':
        f.hook.observation!.origin = 'osc'
        break
      case 'boundary':
        f.hook.observation!.boundary = true
        break
      case 'session-boundary':
        f.hook.sessionBoundary = true
        break
      case 'provider-only':
        f.hook.providerSessionOnly = true
        break
      case 'different-provider':
        f.hook.providerSession!.id = 'previous'
        break
      case 'different-agent':
        f.hook.agentType = 'codex'
        break
      case 'missing-provider':
        delete f.run.providerSessionId
        break
      case 'detached':
        f.hook.onAttachedPty = false
        break
      case 'replaced-pty':
        f.replacePty()
        break
      case 'replaced-handle':
        f.replaceHandle()
        break
      case 'already-final':
        f.run.status = 'completed'
        break
      case 'missing-incarnation':
        delete f.run.terminalProcessIncarnation
        break
      case 'wrong-key':
        f.hook.providerSession!.key = 'conversation_id'
        break
    }
    expect(await f.read()).toBeNull()
  })

  it.each(['pty', 'run', 'hook', 'transport'] as const)(
    'rejects an identity/contact change while reading the final output: %s',
    async (change) => {
      const f = fixture()
      f.readSnapshot.mockImplementation(async () => {
        if (change === 'pty') {
          f.replacePty()
        }
        if (change === 'run') {
          f.run.terminalPtyId = 'replacement'
        }
        if (change === 'hook') {
          f.hook.state = 'working'
        }
        if (change === 'transport') {
          f.runtime.showTerminal.mockRejectedValue(new Error('unverifiable'))
        }
        return null
      })
      expect(await f.read()).toBeNull()
    }
  )

  it('freezes identity before showTerminal yields even when the run mutates in place', async () => {
    const f = fixture()
    f.runtime.showTerminal.mockImplementationOnce(async () => {
      f.run.id = 'new-run'
      return { ptyId: 'pty' }
    })
    expect(await f.read()).toBeNull()
    expect(f.readSnapshot).not.toHaveBeenCalled()
  })

  it('rejects a replacement process resuming the same provider under the same PTY id', async () => {
    const f = fixture()
    f.runtime.getTerminalProcessIncarnation = () => 'pty:replacement-incarnation'
    expect(await f.read()).toBeNull()
    expect(f.readSnapshot).not.toHaveBeenCalled()
  })
})
