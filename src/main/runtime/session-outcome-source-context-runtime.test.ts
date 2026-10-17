import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import { readTerminalSessionOutcomeSourceContext } from './session-outcome-source-context'

vi.mock('./session-outcome-source-context', () => ({
  readTerminalSessionOutcomeSourceContext: vi.fn()
}))

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const runtime = new OrcaRuntimeService(null)
  const identity = { handle: 'source', paneKey: 'source-pane', processIncarnation: 'process-1' }
  const pty = {
    ptyId: 'pty',
    worktreeId: 'workspace',
    connected: true,
    connectionId: null,
    isWsl: false,
    incarnationId: 'generation-1',
    launchIncarnationId: 'generation-1',
    launchAgent: 'codex',
    launchToken: 'source-secret',
    launchConfig: { agentCommand: 'codex', agentArgs: '--model explicit-model', agentEnv: {} }
  }
  const rows = [
    {
      paneKey: identity.paneKey,
      connectionId: null,
      launchToken: pty.launchToken,
      agentType: 'codex',
      state: 'done',
      model: 'actual-source-model',
      lastAssistantMessage: 'Final result.',
      receivedAt: Date.now(),
      stateStartedAt: Date.now(),
      providerSession: { key: 'session_id', id: 'provider-source', transcriptPath: '/source.jsonl' }
    }
  ]
  Object.assign(runtime, {
    ptysById: new Map([['pty', pty]]),
    getAgentStatusSnapshotFn: () => rows,
    getPtyRecordForPaneKey: () => pty
  })
  vi.spyOn(runtime, 'getSessionOutcomeExecutionScope').mockResolvedValue({
    path: '/workspace',
    connectionId: null
  })
  vi.spyOn(runtime, 'resolveSessionOutcomePlanningCoordinator').mockImplementation(() => identity)
  vi.mocked(readTerminalSessionOutcomeSourceContext)
    .mockReset()
    .mockResolvedValue({
      ...identity,
      agent: 'codex',
      model: 'actual-source-model',
      summary: 'Final result.',
      files: []
    })
  return {
    runtime,
    identity,
    pty,
    rows,
    read: () => runtime.readSessionOutcomeSourceContext('source-pane', 'workspace')
  }
}

describe('runtime source context binding', () => {
  it('reads only launch-token-bound source metadata on its execution host', async () => {
    const f = fixture()
    expect(await f.read()).toMatchObject({
      model: 'actual-source-model',
      processIncarnation: 'process-1'
    })
    expect(readTerminalSessionOutcomeSourceContext).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: 'source-pane',
        agent: 'codex',
        transcriptPath: '/source.jsonl',
        status: expect.objectContaining({ model: 'actual-source-model', state: 'done' })
      })
    )
    f.rows[0].launchToken = 'other-process'
    expect(await f.read()).toBeNull()
  })

  it('does not read a remote or WSL source through the local filesystem', async () => {
    const f = fixture()
    vi.mocked(f.runtime.getSessionOutcomeExecutionScope).mockResolvedValue({
      path: '/remote',
      connectionId: 'remote-host'
    })
    expect(await f.read()).toBeNull()
    vi.mocked(f.runtime.getSessionOutcomeExecutionScope).mockResolvedValue({
      path: '/guest',
      connectionId: null,
      wslDistro: 'Ubuntu'
    })
    expect(await f.read()).toBeNull()
    expect(readTerminalSessionOutcomeSourceContext).not.toHaveBeenCalled()
  })

  it('refuses launch metadata retained from a previous PTY incarnation', async () => {
    const f = fixture()
    f.pty.launchIncarnationId = 'previous-generation'
    expect(await f.read()).toBeNull()
    expect(readTerminalSessionOutcomeSourceContext).not.toHaveBeenCalled()
  })

  it('rechecks the source after asynchronous transcript reads', async () => {
    const f = fixture()
    vi.mocked(readTerminalSessionOutcomeSourceContext).mockImplementation(async (input) => {
      f.identity.processIncarnation = 'replacement-process'
      return { ...input, model: 'actual-source-model', summary: 'Final result.', files: [] }
    })
    expect(await f.read()).toBeNull()
  })
})
