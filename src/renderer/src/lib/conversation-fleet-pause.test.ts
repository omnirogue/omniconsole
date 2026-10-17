import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  pauseConversationAfterFleetDispatch,
  pauseSidebarSession,
  type ConversationFleetPauseSource
} from './conversation-fleet-pause'
import type { SidebarSession } from './sidebar-sessions'
import type { ConsoleWorkflowAdmission } from '../../../shared/console-workflow-types'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  capture: vi.fn(),
  resolve: vi.fn(),
  hostTab: vi.fn(),
  state: {} as Record<string, unknown>,
  runtime: undefined as string | undefined
}))
vi.mock('./conversation-fleet-context', () => ({ readConversationFleetContext: mocks.capture }))
vi.mock('@/runtime/runtime-rpc-client', async () => ({
  callRuntimeRpc: mocks.rpc,
  ...(await import('../../../shared/runtime-rpc-error-code'))
}))
vi.mock('@/runtime/web-session-tabs-sync', () => ({
  resolveHostSessionTabIdForWebSessionTab: mocks.hostTab
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./conversation-fleet-context-source', () => ({
  CONVERSATION_FLEET_SOURCE_CHANGED: 'source-changed-during-capture',
  resolveSidebarSource: mocks.resolve,
  resolveConversationFleetSourceRuntimeEnvironment: (source: SidebarSession) =>
    source.hostId?.startsWith('runtime:') ? source.hostId.slice('runtime:'.length) : mocks.runtime
}))

const LEAF_ID = '00000000-0000-4000-8000-000000000001'
const PANE_KEY = `source-tab:${LEAF_ID}`

function session(kind: SidebarSession['kind'] = 'terminal'): SidebarSession {
  return {
    rowKey: 'source-row',
    sessionKey: 'source-key',
    worktreeId: 'workspace',
    hostId: 'local',
    tabId: 'source-tab',
    paneKey: kind === 'terminal' ? PANE_KEY : null,
    kind,
    label: 'Current work',
    workspaceLabel: 'main-next',
    agent: 'Codex',
    unavailable: false,
    folderKeyMigration: null
  }
}

function source(): ConversationFleetPauseSource {
  return {
    sourceSessionId: 'source-session',
    sourceProviderSessionId: 'provider-session',
    sourceWorkingStartedAt: 123,
    sourceTurnId: 'turn-original',
    sourceRuntimeFence: 7
  }
}

function receipt(): ConsoleWorkflowAdmission {
  return {
    workflow_id: 'wf_admitted',
    receipt: { accepted: true },
    jobs: [
      {
        id: 'job_12345678',
        actor_type: 'ai',
        policy: { workflow: { dispatch_id: 'wf_admitted', placement: 'fleet' } }
      }
    ] as ConsoleWorkflowAdmission['jobs']
  }
}

function history(turnId: string | null, fence = 7) {
  return {
    ok: true,
    turnState: { activeTurnId: turnId, lifecycleKnown: true, awaitingStart: false },
    page: {
      sessionId: 'source-session',
      fence,
      items: [
        {
          body: {
            kind: 'status',
            text: '',
            turnLifecycle: {
              turnId: turnId ?? 'turn-finished',
              state: turnId ? 'running' : 'completed'
            }
          }
        }
      ]
    }
  }
}

function personJob(): ConsoleWorkflowAdmission['jobs'][number] {
  return {
    id: 'job_person1234',
    task_id: 'btk_source',
    node_id: null,
    title: 'Deliver to One',
    status: 'queued',
    effort: null,
    repo: null,
    pr_url: null,
    attempt: 0,
    lease_generation: null,
    owned_paths: null,
    updated_at: null,
    blockers: [],
    workflow_state: 'queued',
    can_decide: false,
    actor_type: 'mechanical',
    provider: null,
    model: null,
    machine: null,
    policy: {
      workflow: {
        version: 1,
        digest: 'a'.repeat(64),
        mode: 'single_shot',
        key: 'person',
        actor_type: 'mechanical',
        after: [],
        after_keys: [],
        require_merged: [],
        approval_ancestors: [],
        dispatch_id: 'wf_admitted',
        actor_id: 'stop_rule:person_handoff',
        action: 'notify',
        person_handoff: {
          version: 1,
          approved: true,
          recipient_employee_id: 'emp_one',
          task_id: null,
          note: 'Please review.',
          include_summary: false,
          deliverables: { kind: 'files', paths: [] },
          source_files: [],
          participants: {
            director: { employee_id: 'emp_sal', clerk_user_id: 'user_sal' },
            recipient: { employee_id: 'emp_one', clerk_user_id: 'user_one' }
          }
        }
      }
    }
  }
}

beforeEach(() => {
  mocks.capture.mockReset().mockResolvedValue(source())
  mocks.hostTab.mockReset().mockReturnValue(null)
  mocks.resolve.mockReset().mockImplementation((selected: SidebarSession) => ({
    ...source(),
    title: selected.label,
    sourceHostId: selected.hostId,
    sourceRuntimeEnvironmentId: selected.hostId?.startsWith('runtime:')
      ? selected.hostId.slice('runtime:'.length)
      : mocks.runtime,
    sourceWorkspacePath: '/repo',
    sourceAgent: 'codex',
    sourceKind: selected.kind === 'structured' ? 'structured' : 'provider'
  }))
  mocks.rpc.mockReset()
  mocks.runtime = undefined
  mocks.state = {
    agentStatusByPaneKey: {
      [PANE_KEY]: {
        providerSession: { id: 'provider-session' },
        worktreeId: 'workspace',
        state: 'working',
        stateStartedAt: 123
      }
    },
    unifiedTabsByWorktree: {
      workspace: [{ id: 'source-tab', contentType: 'agent-session', entityId: 'source-session' }]
    }
  }
})

describe('pause the source after fleet admission', () => {
  it('accepts the backend fleet receipt when its default placement is omitted', async () => {
    const accepted = receipt()
    delete accepted.jobs[0]!.policy.workflow.placement
    mocks.rpc.mockResolvedValueOnce(history('turn-original'))
    mocks.rpc.mockResolvedValueOnce({
      ok: true,
      value: { turnId: 'turn-original', cancelled: true }
    })
    const result = await pauseConversationAfterFleetDispatch(
      session('structured'),
      source(),
      accepted
    )
    expect(result.state).toBe('paused')
    expect(mocks.rpc.mock.calls[1]?.[1]).toBe('agentSession.cancel')
  })

  it('rejects an explicitly local admission before sending any source command', async () => {
    const accepted = receipt()
    accepted.jobs[0]!.policy.workflow.placement = 'local'
    const result = await pauseConversationAfterFleetDispatch(session(), source(), accepted)
    expect(result.state).toBe('unverifiable')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'accepts canonical person delivery receipts with no machine placement (people only: %s)',
    async (peopleOnly) => {
      mocks.rpc.mockResolvedValueOnce(history('turn-original'))
      mocks.rpc.mockResolvedValueOnce({
        ok: true,
        value: { turnId: 'turn-original', cancelled: true }
      })
      const accepted = {
        ...receipt(),
        jobs: peopleOnly ? [personJob()] : [...receipt().jobs, personJob()]
      }
      expect(
        (await pauseConversationAfterFleetDispatch(session('structured'), source(), accepted)).state
      ).toBe('paused')
      expect(mocks.rpc.mock.calls[1]?.[1]).toBe('agentSession.cancel')
    }
  )

  it('refuses a human approval job disguised as a person delivery admission', async () => {
    const job = personJob()
    job.actor_type = 'human'
    const result = await pauseConversationAfterFleetDispatch(session(), source(), {
      ...receipt(),
      jobs: [job]
    })
    expect(result.state).toBe('unverifiable')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('requires an admitted workflow before issuing any host command', async () => {
    const result = await pauseConversationAfterFleetDispatch(session(), source(), {
      ...receipt(),
      jobs: []
    })
    expect(result.state).toBe('unverifiable')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('cancels only the captured structured turn on the owning runtime', async () => {
    mocks.rpc.mockResolvedValueOnce(history('turn-original'))
    mocks.rpc.mockResolvedValueOnce({
      ok: true,
      value: { turnId: 'turn-original', cancelled: true }
    })
    const result = await pauseConversationAfterFleetDispatch(
      { ...session('structured'), hostId: 'runtime:rented-mac' },
      source(),
      receipt()
    )
    expect(result.state).toBe('paused')
    expect(mocks.rpc.mock.calls[1]?.slice(0, 3)).toMatchObject([
      { kind: 'environment', environmentId: 'rented-mac' },
      'agentSession.cancel',
      {
        turnId: 'turn-original',
        envelope: { sessionId: 'source-session', expectedRuntimeFence: 7 }
      }
    ])
  })

  it.each([
    ['turn-new', 7],
    ['turn-original', 8]
  ] as const)('does not cancel a newer structured turn or owner (%s/%s)', async (turn, fence) => {
    mocks.rpc.mockResolvedValueOnce(history(turn, fence))
    expect(
      (await pauseConversationAfterFleetDispatch(session('structured'), source(), receipt())).state
    ).toBe('source-changed')
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('sends no cancellation for a structured turn already completed', async () => {
    mocks.rpc.mockResolvedValueOnce(history(null))
    expect(
      (await pauseConversationAfterFleetDispatch(session('structured'), source(), receipt())).state
    ).toBe('already-idle')
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('does not invent idle from a tail that omitted the lifecycle record', async () => {
    mocks.rpc.mockResolvedValueOnce({
      ok: true,
      page: { sessionId: 'source-session', fence: 7, items: [] }
    })
    const result = await pauseConversationAfterFleetDispatch(
      session('structured'),
      { ...source(), sourceTurnId: undefined },
      receipt()
    )
    expect(result.state).toBe('unverifiable')
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it("uses the composer's stop key through the exact SSH terminal and verifies idle", async () => {
    mocks.rpc.mockResolvedValueOnce({
      terminal: { handle: 'exact-handle', ptyId: 'remote-pty', executionHostId: 'ssh:rented-mac' }
    })
    mocks.rpc.mockResolvedValueOnce({ agentStatus: { isRunningAgent: true, status: 'working' } })
    mocks.rpc.mockResolvedValueOnce({ send: { accepted: true, bytesWritten: 1 } })
    mocks.rpc.mockResolvedValueOnce({
      wait: { condition: 'tui-idle', satisfied: true, status: 'running' }
    })
    const result = await pauseConversationAfterFleetDispatch(
      { ...session(), hostId: 'ssh:rented-mac' },
      source(),
      receipt()
    )
    expect(result.state).toBe('paused')
    expect(mocks.rpc.mock.calls[2]?.slice(0, 3)).toMatchObject([
      { kind: 'local' },
      'terminal.send',
      { terminal: 'exact-handle', text: '\u001b' }
    ])
    expect(mocks.rpc.mock.calls.map((call) => call[1])).not.toContain('terminal.close')
  })

  it('refuses remote source fallback to a local terminal', async () => {
    mocks.rpc.mockResolvedValueOnce({
      terminal: { handle: 'wrong-handle', ptyId: 'local-pty', executionHostId: 'local' }
    })
    const result = await pauseConversationAfterFleetDispatch(
      { ...session(), hostId: 'ssh:rented-mac' },
      source(),
      receipt()
    )
    expect(result.state).toBe('unverifiable')
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('pauses an SSH source through its captured paired runtime', async () => {
    mocks.runtime = 'paired-owner'
    mocks.rpc.mockResolvedValueOnce({
      terminal: { handle: 'exact-handle', ptyId: 'remote-pty', executionHostId: 'ssh:rented-mac' }
    })
    mocks.rpc.mockResolvedValueOnce({ agentStatus: { isRunningAgent: true, status: 'working' } })
    mocks.rpc.mockResolvedValueOnce({ send: { accepted: true } })
    mocks.rpc.mockResolvedValueOnce({ wait: { condition: 'tui-idle', satisfied: true } })
    const result = await pauseConversationAfterFleetDispatch(
      { ...session(), hostId: 'ssh:rented-mac' },
      {
        ...source(),
        sourceHostId: 'ssh:rented-mac',
        sourceRuntimeEnvironmentId: 'paired-owner'
      },
      receipt()
    )
    expect(result.state).toBe('paused')
    expect(mocks.rpc.mock.calls.every((call) => call[0].environmentId === 'paired-owner')).toBe(
      true
    )
  })

  it('does not send source input after the owning runtime changes', async () => {
    mocks.runtime = 'different-owner'
    const result = await pauseConversationAfterFleetDispatch(
      { ...session(), hostId: 'ssh:rented-mac' },
      {
        ...source(),
        sourceHostId: 'ssh:rented-mac',
        sourceRuntimeEnvironmentId: 'captured-owner'
      },
      receipt()
    )
    expect(result.state).toBe('unverifiable')
    expect(result.message).toContain('owner changed')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('does not interrupt a new terminal turn after the snapshot was captured', async () => {
    mocks.rpc.mockResolvedValueOnce({
      terminal: { handle: 'exact-handle', ptyId: 'pty', executionHostId: 'local' }
    })
    mocks.rpc.mockImplementationOnce(async () => {
      const statuses = mocks.state.agentStatusByPaneKey as Record<
        string,
        { stateStartedAt: number }
      >
      statuses[PANE_KEY]!.stateStartedAt = 456
      return { agentStatus: { isRunningAgent: true, status: 'working' } }
    })
    expect((await pauseConversationAfterFleetDispatch(session(), source(), receipt())).state).toBe(
      'source-changed'
    )
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })

  it('keeps a pause unverifiable when the host cannot confirm the stop', async () => {
    mocks.rpc.mockResolvedValueOnce({
      terminal: { handle: 'exact-handle', ptyId: 'pty', executionHostId: 'local' }
    })
    mocks.rpc.mockResolvedValueOnce({ agentStatus: { isRunningAgent: true, status: 'working' } })
    mocks.rpc.mockResolvedValueOnce({ send: { accepted: true } })
    mocks.rpc.mockRejectedValueOnce(new Error('timeout'))
    expect((await pauseConversationAfterFleetDispatch(session(), source(), receipt())).state).toBe(
      'unverifiable'
    )
  })

  it('does not interrupt a new prompt in a continuously working source session', async () => {
    mocks.rpc.mockResolvedValueOnce({
      terminal: { handle: 'exact-handle', ptyId: 'pty', executionHostId: 'local' }
    })
    mocks.rpc.mockResolvedValueOnce({ agentStatus: { isRunningAgent: true, status: 'working' } })
    const result = await pauseConversationAfterFleetDispatch(
      session(),
      { ...source(), sourcePrompt: 'The captured request' },
      receipt()
    )
    expect(result.state).toBe('source-changed')
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })
})

describe('explicit user pause', () => {
  const capabilities = () => ({
    version: 1,
    durableContinuation: true,
    executionRuntimeId: 'owner-runtime',
    remoteRuntimeOwnership: 1,
    placementScope: 'runtime-local'
  })
  const terminal = (hostId = 'local', tabId = 'source-tab') => ({
    terminal: {
      handle: 'exact-handle',
      ptyId: 'exact-pty',
      tabId,
      leafId: LEAF_ID,
      worktreeId: 'workspace',
      executionHostId: hostId,
      connected: true
    }
  })

  it('pauses the captured structured turn without requiring a fleet dispatch', async () => {
    mocks.rpc.mockResolvedValueOnce(capabilities())
    mocks.rpc.mockResolvedValueOnce(history('turn-original'))
    mocks.rpc.mockResolvedValueOnce({
      state: 'paused',
      message: 'Paused; Keep going is off.',
      keepGoingStopped: true
    })
    expect((await pauseSidebarSession(session('structured'))).state).toBe('paused')
    expect(mocks.rpc.mock.calls[1]?.[2]).toEqual({
      sessionId: 'source-session',
      direction: 'tail',
      limit: 200
    })
    expect(mocks.rpc.mock.calls[2]?.slice(0, 3)).toEqual([
      { kind: 'local' },
      'sessionOwner.pause',
      {
        expectedExecutionRuntimeId: 'owner-runtime',
        target: {
          kind: 'structured',
          hostId: 'local',
          worktreeId: 'workspace',
          sessionId: 'source-session',
          turnId: 'turn-original',
          runtimeFence: 7
        }
      }
    ])
    expect(mocks.capture).not.toHaveBeenCalled()
  })

  it('refuses an unavailable host without capturing or sending commands', async () => {
    expect((await pauseSidebarSession({ ...session(), unavailable: true })).state).toBe(
      'unverifiable'
    )
    expect(mocks.capture).not.toHaveBeenCalled()
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('does not cancel a replacement turn', async () => {
    mocks.rpc.mockResolvedValueOnce(capabilities())
    mocks.rpc.mockResolvedValueOnce(history('turn-original'))
    mocks.rpc.mockResolvedValueOnce({ state: 'source-changed', message: 'Turn changed.' })
    expect((await pauseSidebarSession(session('structured'))).state).toBe('source-changed')
    expect(mocks.rpc).toHaveBeenCalledTimes(3)
    expect(mocks.rpc.mock.calls.map((call) => call[1])).not.toContain('agentSession.cancel')
  })

  it.each(['paused', 'already-idle'] as const)(
    'uses the owner result %s without reading a transcript or sending terminal input',
    async (state) => {
      mocks.rpc.mockResolvedValueOnce(capabilities())
      mocks.rpc.mockResolvedValueOnce(terminal())
      mocks.rpc.mockResolvedValueOnce({
        state,
        message: 'Owner confirmed',
        keepGoingStopped: state === 'paused'
      })
      expect((await pauseSidebarSession(session())).state).toBe(state)
      expect(mocks.rpc.mock.calls[1]?.[2]).toEqual({ paneKey: PANE_KEY, worktreeId: 'workspace' })
      expect(mocks.rpc.mock.calls[2]?.[2]).toMatchObject({
        expectedExecutionRuntimeId: 'owner-runtime',
        target: {
          hostId: 'local',
          paneKey: PANE_KEY,
          providerSessionId: 'provider-session',
          terminalHandle: 'exact-handle',
          ptyId: 'exact-pty',
          workingStartedAt: 123
        }
      })
      expect(mocks.rpc.mock.calls.map((call) => call[1])).toEqual([
        'sessionChain.outcomeCapabilities',
        'terminal.resolvePane',
        'sessionOwner.pause'
      ])
      expect(mocks.capture).not.toHaveBeenCalled()
    }
  )

  it('routes a mirrored pane to its exact paired owner and host coordinates', async () => {
    mocks.hostTab.mockReturnValue('host-tab')
    mocks.rpc.mockResolvedValueOnce(capabilities())
    mocks.rpc.mockResolvedValueOnce(terminal('local', 'host-tab'))
    mocks.rpc.mockResolvedValueOnce({ state: 'already-idle', message: 'Already idle' })
    expect(
      (await pauseSidebarSession({ ...session(), hostId: 'runtime:paired-owner' })).state
    ).toBe('already-idle')
    expect(mocks.rpc.mock.calls.every((call) => call[0].environmentId === 'paired-owner')).toBe(
      true
    )
    expect(mocks.rpc.mock.calls[2]?.[2].target).toMatchObject({
      hostId: 'local',
      paneKey: `host-tab:${LEAF_ID}`,
      tabId: 'host-tab'
    })
  })

  it('does not fall back to raw input when an older host lacks person Pause', async () => {
    mocks.rpc.mockResolvedValueOnce(capabilities())
    mocks.rpc.mockResolvedValueOnce(terminal())
    mocks.rpc.mockRejectedValueOnce(new Error('method_not_found'))
    const result = await pauseSidebarSession(session())
    expect(result).toMatchObject({ state: 'unverifiable' })
    expect(result.message).toContain('Update the execution host')
    expect(mocks.rpc).toHaveBeenCalledTimes(3)
  })

  it.each([undefined, 'paired-controller'])(
    'keeps SSH execution on its controller (%s)',
    async (controller) => {
      mocks.runtime = controller
      mocks.rpc.mockResolvedValueOnce(capabilities())
      mocks.rpc.mockResolvedValueOnce(terminal('ssh:rented-mac'))
      mocks.rpc.mockResolvedValueOnce({ state: 'already-idle', message: 'Already idle' })
      expect((await pauseSidebarSession({ ...session(), hostId: 'ssh:rented-mac' })).state).toBe(
        'already-idle'
      )
      expect(
        mocks.rpc.mock.calls.every((call) =>
          controller ? call[0].environmentId === controller : call[0].kind === 'local'
        )
      ).toBe(true)
      expect(mocks.rpc.mock.calls[2]?.[2].target.hostId).toBe('ssh:rented-mac')
    }
  )

  it('refuses a terminal replacement before invoking owner Pause', async () => {
    mocks.rpc.mockResolvedValueOnce(capabilities())
    mocks.rpc.mockResolvedValueOnce(terminal('ssh:different-host'))
    expect((await pauseSidebarSession(session())).state).toBe('unverifiable')
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })

  it('reports changed identity before capture without misleading handoff errors', async () => {
    mocks.resolve.mockImplementation(() => {
      throw new Error('source-changed-during-capture')
    })
    const result = await pauseSidebarSession(session())
    expect(result.state).toBe('source-changed')
    expect(result.message).not.toContain('handoff')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it.each(['lifecycle', 'fence'] as const)(
    'does not invent idle or call Pause when the structured %s is missing',
    async (missing) => {
      mocks.rpc.mockResolvedValueOnce(capabilities())
      mocks.rpc.mockResolvedValueOnce({
        ok: true,
        ...(missing === 'lifecycle'
          ? {}
          : { turnState: { activeTurnId: null, lifecycleKnown: true, awaitingStart: false } }),
        page: {
          sessionId: 'source-session',
          ...(missing === 'fence' ? {} : { fence: 7 }),
          items: []
        }
      })
      expect((await pauseSidebarSession(session('structured'))).state).toBe('unverifiable')
      expect(mocks.rpc).toHaveBeenCalledTimes(2)
    }
  )

  it('uses owner turn metadata when a long turn has no lifecycle item in the tail', async () => {
    const captured = history('long-turn')
    captured.page.items = []
    mocks.rpc.mockResolvedValueOnce(capabilities())
    mocks.rpc.mockResolvedValueOnce(captured)
    mocks.rpc.mockResolvedValueOnce({ state: 'paused', message: 'Paused' })
    expect((await pauseSidebarSession(session('structured'))).state).toBe('paused')
    expect(mocks.rpc.mock.calls[2]?.[2].target).toMatchObject({
      turnId: 'long-turn',
      runtimeFence: 7
    })
  })
})
