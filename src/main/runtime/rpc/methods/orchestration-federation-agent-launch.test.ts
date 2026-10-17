import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../omni-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

// Why: a federated worker terminal is created from an agent id. Passing that id
// as a shell command launched Cursor's desktop app instead of `cursor-agent`
// (issue #11926), so the remote path must resolve through the TUI agent config
// exactly like the local one.
describe('federated worker agent launch', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it.each(['folder:remote-workspace', 'repo::remote-worktree'])(
    'creates an unbound exact workspace worker through the configured agent launcher: %s',
    async (worktreeId) => {
      db = new OrchestrationDb(':memory:')
      const runtime = new OrcaRuntimeService()
      runtime.setOrchestrationDb(db)
      vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
      vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
        id: worktreeId
      } as never)
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
        handle: 'term_remote_worker',
        worktreeId,
        title: 'worker'
      })
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: 'term_remote_worker',
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      })
      // Why: without a stable pane the handler bails at agent_readiness, so the
      // assertions below would pass against a worker that never actually started.
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_remote:leaf_remote')
      vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(
        'runtime_test:term_remote_worker:1'
      )
      vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('omni')
      vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
        handle: 'term_remote_worker',
        accepted: true,
        bytesWritten: 1
      })
      const method = ORCHESTRATION_METHODS.find(
        (candidate) => candidate.name === 'orchestration.federationAttachStart'
      )
      if (!method) {
        throw new Error('federationAttachStart method is not registered')
      }

      const result = (await method.handler(
        method.params!.parse({
          dispatchId: 'ctx_0123456789ab',
          taskId: 'task_0123456789ab',
          taskSpec: 'remote cursor worker',
          depth: 2,
          protocolVersion: 3,
          worktree: worktreeId,
          agent: 'cursor',
          model: 'gpt-5.3-codex',
          effort: 'high'
        }),
        {
          runtime,
          pairedDeviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          clientKind: 'runtime',
          requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          orchestrationMutation: {
            callerFingerprint: 'home_peer',
            requestId: 'request_remote',
            method: 'orchestration.federationAttachStart',
            payloadHash: 'remote_payload'
          }
        }
      )) as {
        state: string
        failedStage?: string
        lastError?: string
        launch: unknown
      }

      // Why: assert the worker actually reached ready — a spy-only assertion would
      // stay green even if every stage after terminal_create regressed.
      expect(result).toMatchObject({
        state: 'ready',
        launch: {
          requested: { agent: 'cursor', model: 'gpt-5.3-codex', effort: 'high' },
          effective: { agent: 'cursor', model: 'gpt-5.3-codex', effort: 'high' }
        }
      })
      expect(db.getRemoteDispatchAttachment('ctx_0123456789ab')?.depth).toBe(2)
      expect(db.getRemoteDispatchAttachment('ctx_0123456789ab')?.hub_task_id).toBeNull()

      expect(createTerminal).toHaveBeenCalledWith(
        `id:${worktreeId}`,
        expect.objectContaining({
          startupAgent: 'cursor',
          launchPreferences: { model: 'gpt-5.3-codex', effort: 'high' }
        })
      )
      expect(createTerminal).toHaveBeenCalledWith(
        `id:${worktreeId}`,
        expect.not.objectContaining({ command: expect.anything() })
      )
      expect(createTerminal).toHaveBeenCalledOnce()
      const digest = (value: string) => createHash('sha256').update(value).digest('hex')
      expect(createTerminal.mock.calls[0][1]?.launchCause).toEqual({
        trigger: 'orchestration-worker',
        actor: {
          kind: 'paired-device',
          deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          clientKind: 'runtime'
        },
        requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        clientMutationIdHash: digest('request_remote'),
        claimedTrigger: 'orchestration-worker',
        claimedReferenceHashes: {
          orchestrationTaskId: `hash_${digest('task_0123456789ab').slice(0, 12)}`,
          orchestrationDispatchId: `hash_${digest('ctx_0123456789ab').slice(0, 12)}`
        }
      })
    }
  )

  it.each([
    { protocolVersion: 1, worktree: 'folder:remote-workspace', agent: 'cursor' },
    {
      protocolVersion: 2,
      worktree: 'new-top-level',
      repo: 'remote-repo',
      name: 'worker',
      agent: 'cursor'
    },
    { protocolVersion: 3, worktree: 'repo::remote-worktree', terminal: 'term_existing_agent' }
  ])('fences direct Hub-bound attachment before any effects: %j', async (placement) => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const readDb = vi.spyOn(runtime, 'getOrchestrationDb')
    const validateAgent = vi.spyOn(runtime, 'validateOrchestrationAgentLauncher')
    const showRepo = vi.spyOn(runtime, 'showRepo')
    const showWorkspace = vi.spyOn(runtime, 'showManagedTerminalWorkspace')
    const createWorktree = vi.spyOn(runtime, 'createManagedWorktree')
    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    const showTerminal = vi.spyOn(runtime, 'showTerminal')
    const sendPrompt = vi.spyOn(runtime, 'sendTerminalAgentPrompt')
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )!
    await expect(
      method.handler(
        method.params!.parse({
          dispatchId: 'ctx_bound_remote',
          taskId: 'task_bound_remote',
          taskSpec: 'canonical bound work',
          hubTaskId: 'btk_remotefolder',
          hubStateRevision: 3,
          ...placement
        }),
        {
          runtime,
          orchestrationMutation: {
            callerFingerprint: 'home_peer',
            requestId: 'request_bound_remote',
            method: 'orchestration.federationAttachStart',
            payloadHash: 'bound_payload'
          }
        }
      )
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    for (const effect of [
      readDb,
      validateAgent,
      showRepo,
      showWorkspace,
      createWorktree,
      createTerminal,
      showTerminal,
      sendPrompt
    ]) {
      expect(effect).not.toHaveBeenCalled()
    }
    expect(db.getRemoteDispatchAttachment('ctx_bound_remote')).toBeUndefined()
    expect(db.getMutationReceipt('home_peer', 'request_bound_remote')).toBeUndefined()
  })
})
