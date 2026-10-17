import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../shared/agent-session-wire'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import {
  readAiVaultConversationFleetContext,
  readConversationFleetContext
} from './conversation-fleet-context'
import { providerSessionFolderKey, structuredSessionFolderKey } from './session-folder-identity'
import type { SidebarSession } from './sidebar-sessions'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), workspace: vi.fn(), state: {} as AppState }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('./session-chain-client', () => ({ readTerminalTailFromHost: vi.fn() }))
vi.mock('./session-chain-support', () => ({
  workspaceRuntimeTarget: vi.fn(),
  chainAbortError: vi.fn()
}))

const provider = {
  key: 'session_id' as const,
  id: 'source-1',
  transcriptPath: '/owner/session.jsonl'
}
const signal = () => new AbortController().signal
const jsonVaultSession = (agent: AiVaultSession['agent']): AiVaultSession => ({
  id: 'vault-row-1',
  title: 'Saved provider conversation',
  executionHostId: 'runtime:archive',
  sessionId: 'vault-1',
  agent,
  filePath: '/archive/conversation.json',
  cwd: '/archive/work',
  branch: null,
  model: null,
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-09-12T00:00:00Z',
  messageCount: 1,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: '',
  subagent: null
})
const message = (
  id: string,
  text: string,
  role: NativeChatMessage['role'] = 'assistant'
): NativeChatMessage => ({
  id,
  role,
  blocks: [{ type: 'text', text }],
  source: 'transcript',
  timestamp: 1
})
const row = (overrides: Partial<SidebarSession> = {}): SidebarSession => ({
  rowKey: 'row-1',
  sessionKey: providerSessionFolderKey({
    hostId: 'runtime:owner',
    worktreeId: 'workspace',
    agent: 'codex',
    providerSession: provider
  }),
  worktreeId: 'workspace',
  hostId: 'runtime:owner',
  tabId: 'tab',
  paneKey: 'pane',
  kind: 'terminal',
  label: 'Review checkout',
  workspaceLabel: 'Checkout',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null,
  ...overrides
})
const transcriptCursor = (byteOffset: number, snapshotSize = 100000) => ({
  filePath: provider.transcriptPath,
  byteOffset,
  snapshotSize,
  fileIdentity: 'file-1',
  sourceEpoch: 'epoch-1',
  observedSize: snapshotSize,
  observedMtime: 123,
  connectionId: null,
  agent: 'codex',
  sessionId: provider.id
})
const nativePage = (messages: NativeChatMessage[], extra: Record<string, unknown> = {}) => ({
  source: { connectionId: null },
  messages,
  complete: true,
  sourceRecords: messages.map((message, index) => ({
    byteOffset: index,
    text: JSON.stringify(message)
  })),
  coverage: {
    format: 'jsonl',
    projection: 'display',
    fromByteOffset: 0,
    toByteOffset: 100000,
    snapshotBytes: 100000,
    rawRecords: 'complete'
  },
  malformedRecordCount: 0,
  oversizedRecordCount: 0,
  truncatedRecordCount: 0,
  ...extra
})
const item = (sequence: number, text: string): AgentJournalRenderItem => ({
  itemId: `item-${sequence}`,
  revision: 1,
  sequence,
  observedAt: sequence,
  body: {
    kind: 'message',
    role: sequence === 1 ? 'user' : 'assistant',
    blocks: [{ type: 'text', text }]
  }
})
const historyPage = (
  items: AgentJournalRenderItem[],
  hasOlder = false
): AgentSessionHistoryPage => ({
  sessionId: 'structured-1',
  epoch: 'epoch-1',
  direction: 'tail',
  items,
  removedItemIds: [],
  submissions: [],
  window: {
    oldest: items.length ? { epoch: 'epoch-1', sequence: items[0].sequence } : null,
    newest: items.length ? { epoch: 'epoch-1', sequence: items.at(-1)?.sequence ?? 0 } : null,
    nextCursor: { epoch: 'epoch-1', sequence: items[0]?.sequence ?? 0 }
  },
  hasOlder,
  hasNewer: false
})
const structuredRow = (): SidebarSession =>
  row({
    kind: 'structured',
    paneKey: null,
    sessionKey: structuredSessionFolderKey('runtime:owner', 'structured-1')
  })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.workspace.mockReturnValue({ path: '/owner/work' })
  mocks.state = {
    getKnownWorktreeById: mocks.workspace,
    folderWorkspaces: [],
    projectGroups: [],
    agentStatusByPaneKey: {
      pane: { worktreeId: 'workspace', agentType: 'codex', providerSession: provider }
    },
    sleepingAgentSessionsByPaneKey: {},
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    tabsByWorktree: { workspace: [{ id: 'tab' }] },
    unifiedTabsByWorktree: {
      workspace: [
        {
          id: 'tab',
          contentType: 'agent-session',
          entityId: 'structured-1',
          executionHostId: 'runtime:owner',
          agentSessionAgent: 'codex'
        }
      ]
    }
  } as unknown as AppState
})

describe('fleet conversation capture', () => {
  it('captures all forward pages and long messages from the selected owning runtime', async () => {
    const longReply = `START-${'long conversation '.repeat(5000)}-END`
    const cursor = transcriptCursor(150)
    mocks.rpc
      .mockResolvedValueOnce(
        nativePage([message('ask', 'Original requirement', 'user')], {
          complete: false,
          cursor,
          coverage: { ...nativePage([]).coverage, toByteOffset: 150 }
        })
      )
      .mockResolvedValueOnce(
        nativePage([message('reply', longReply)], {
          coverage: { ...nativePage([]).coverage, fromByteOffset: 150 }
        })
      )
    const result = await readConversationFleetContext(row(), signal())
    expect(result.transcript).toBe(`Person:\nOriginal requirement\n\nAgent:\n${longReply}`)
    expect(result.sourceRawTranscript).toBe(
      [message('ask', 'Original requirement', 'user'), message('reply', longReply)]
        .map((value) => JSON.stringify(value))
        .join('\n')
    )
    expect(result.sourceRawFormat).toBe('provider-jsonl')
    expect(result.sourceSummary).toBe(longReply)
    expect(result).toMatchObject({
      sourceHostId: 'runtime:owner',
      sourceWorkspacePath: '/owner/work',
      sourceSessionId: 'source-1',
      sourceTranscriptPath: provider.transcriptPath,
      sourceContextWarnings: []
    })
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      { kind: 'environment', environmentId: 'owner' },
      'nativeChat.readTranscriptPage',
      expect.objectContaining({ cursor }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(mocks.workspace).toHaveBeenCalledWith('workspace', 'runtime:owner')
  })

  it('reads a retained sleeping provider without active agent status', async () => {
    mocks.state.agentStatusByPaneKey = {}
    mocks.state.sleepingAgentSessionsByPaneKey = {
      pane: {
        paneKey: 'pane',
        worktreeId: 'workspace',
        agent: 'codex',
        providerSession: provider,
        prompt: 'Old prompt',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1
      }
    }
    mocks.rpc.mockResolvedValue(nativePage([message('retained', 'Retained complete response')]))
    expect(
      (await readConversationFleetContext(row({ tabId: null }), signal())).transcript
    ).toContain('Retained complete response')
  })

  it('does not borrow retained identity for a newly active pane with no session', async () => {
    mocks.state.agentStatusByPaneKey.pane.providerSession = undefined
    mocks.state.sleepingAgentSessionsByPaneKey = {
      pane: {
        paneKey: 'pane',
        worktreeId: 'workspace',
        agent: 'codex',
        providerSession: provider,
        prompt: '',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1
      }
    }
    await expect(readConversationFleetContext(row(), signal())).rejects.toThrow(
      'saved a readable session identity'
    )
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('refuses source replacement during capture instead of returning another conversation', async () => {
    mocks.rpc.mockImplementation(async () => {
      mocks.state.agentStatusByPaneKey.pane.providerSession = { ...provider, id: 'replacement' }
      return nativePage([message('old', 'Old transcript')])
    })
    await expect(readConversationFleetContext(row(), signal())).rejects.toThrow(
      'source conversation changed'
    )
  })

  it('routes SSH paths only through the explicit host reader and checks its acknowledgement', async () => {
    mocks.state.agentStatusByPaneKey.pane.connectionId = 'rented-mac'
    mocks.rpc.mockResolvedValue(
      nativePage([message('remote', 'Remote source')], { source: { connectionId: 'rented-mac' } })
    )
    const sshRow = row({
      hostId: 'ssh:rented-mac',
      sessionKey: providerSessionFolderKey({
        hostId: 'ssh:rented-mac',
        worktreeId: 'workspace',
        agent: 'codex',
        providerSession: provider
      })
    })
    await readConversationFleetContext(sshRow, signal())
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'nativeChat.readTranscriptPage',
      expect.objectContaining({
        connectionId: 'rented-mac',
        transcriptPath: '/owner/session.jsonl'
      }),
      expect.any(Object)
    )
    mocks.rpc.mockResolvedValue(nativePage([message('wrong', 'Local namesake')]))
    await expect(readConversationFleetContext(sshRow, signal())).rejects.toThrow(
      'source execution host'
    )
  })

  it.each(['malformedRecordCount', 'oversizedRecordCount', 'truncatedRecordCount'])(
    'refuses to label history complete after %s loses a record',
    async (field) => {
      mocks.rpc.mockResolvedValue(nativePage([message('tail', 'Only the tail')], { [field]: 1 }))
      await expect(readConversationFleetContext(row(), signal())).rejects.toThrow(
        'complete conversation could not be captured'
      )
    }
  )

  it('refuses a nonadvancing cursor instead of silently accepting a capped transcript', async () => {
    mocks.rpc
      .mockResolvedValueOnce(
        nativePage([message('tail', 'Only the tail')], {
          complete: false,
          cursor: transcriptCursor(50),
          coverage: { ...nativePage([]).coverage, toByteOffset: 50 }
        })
      )
      .mockResolvedValue(
        nativePage([], {
          complete: false,
          cursor: transcriptCursor(50),
          coverage: { ...nativePage([]).coverage, fromByteOffset: 50, toByteOffset: 50 }
        })
      )
    await expect(readConversationFleetContext(row(), signal())).rejects.toThrow(
      'cannot verify complete'
    )
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })

  it('cancels before starting and after a provider request without fallback reads', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(readConversationFleetContext(row(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(mocks.rpc).not.toHaveBeenCalled()
    const duringRead = new AbortController()
    mocks.rpc.mockImplementation(async () => {
      duringRead.abort()
      return nativePage([message('result', 'Read finished after cancel')])
    })
    await expect(readConversationFleetContext(row(), duringRead.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('captures retained AI Vault rows by exact session, path and host without a pane', async () => {
    const vault = {
      title: 'Saved discussion',
      executionHostId: 'runtime:archive',
      sessionId: 'vault-1',
      agent: 'claude',
      filePath: '/archive/real.jsonl',
      cwd: '/archive/work'
    } as unknown as AiVaultSession
    mocks.rpc.mockResolvedValue(nativePage([message('saved', 'Complete saved message')]))
    const result = await readAiVaultConversationFleetContext(vault, signal())
    expect(result).toMatchObject({
      title: 'Saved discussion',
      sourceSessionId: 'vault-1',
      sourceWorkspacePath: '/archive/work',
      sourceHostId: 'runtime:archive'
    })
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'archive' },
      'nativeChat.readTranscriptPage',
      expect.objectContaining({ sessionId: 'vault-1', transcriptPath: '/archive/real.jsonl' }),
      expect.any(Object)
    )
  })

  it('preserves original records for a JSONL provider without a display parser', async () => {
    const raw = '{"role":"user","content":"Every original word","extra":{"provider":"kimi"}}'
    mocks.rpc.mockResolvedValue(
      nativePage([], {
        sourceRecords: [{ byteOffset: 0, text: raw }],
        coverage: { ...nativePage([]).coverage, projection: 'raw-only' }
      })
    )
    const result = await readConversationFleetContext(row(), signal())
    expect(result.sourceRawTranscript).toBe(raw)
    expect(result.sourceSummary).toBeUndefined()
    expect(result.transcript).toContain(raw)
    expect(result.sourceContextWarnings).toEqual([
      'This provider has no display parser; its complete original transcript records are included.'
    ])
  })

  it('preserves owning-host warnings about media outside the transcript', async () => {
    const warning =
      'Kimi attachment blob references are preserved; separate media blob files are not included in the transcript.'
    mocks.rpc.mockResolvedValue(
      nativePage([message('text', 'Readable source')], { warnings: [warning] })
    )
    expect((await readConversationFleetContext(row(), signal())).sourceContextWarnings).toEqual([
      warning
    ])
  })

  it('pins the current terminal work identity for a later handoff pause', async () => {
    Object.assign(mocks.state.agentStatusByPaneKey.pane, {
      state: 'working',
      stateStartedAt: 700,
      terminalHandle: 'owner-terminal',
      prompt: 'Original work'
    })
    mocks.rpc.mockResolvedValue(nativePage([message('work', 'In progress')]))
    expect(await readConversationFleetContext(row(), signal())).toMatchObject({
      sourceProviderSessionId: provider.id,
      sourceWorkingStartedAt: 700,
      sourceTerminalHandle: 'owner-terminal',
      sourcePrompt: 'Original work'
    })
  })

  it('refuses new user steering even when the provider and working timestamp stay the same', async () => {
    Object.assign(mocks.state.agentStatusByPaneKey.pane, {
      state: 'working',
      stateStartedAt: 700,
      prompt: 'Original work'
    })
    mocks.rpc.mockImplementation(async () => {
      mocks.state.agentStatusByPaneKey.pane.prompt = 'A new instruction'
      return nativePage([message('old', 'Prior conversation')])
    })
    await expect(readConversationFleetContext(row(), signal())).rejects.toThrow(
      'source conversation changed'
    )
  })

  it('retains whole Gemini JSON with honest source format metadata', async () => {
    const raw = JSON.stringify({
      messages: [{ role: 'user', content: 'Gemini source conversation' }]
    })
    mocks.rpc.mockResolvedValue(
      nativePage([], {
        sourceRecords: [{ byteOffset: 0, text: raw }],
        coverage: { ...nativePage([]).coverage, format: 'json', projection: 'raw-only' }
      })
    )
    expect(
      await readAiVaultConversationFleetContext(jsonVaultSession('gemini'), signal())
    ).toMatchObject({
      sourceRawTranscript: raw,
      sourceRawFormat: 'provider-json'
    })
  })

  it.each([
    {
      agent: 'devin' as const,
      document: {
        sessionId: 'vault-1',
        steps: [{ role: 'assistant', content: 'Complete Devin response' }]
      }
    },
    {
      agent: 'rovo' as const,
      document: {
        session_id: 'vault-1',
        message_history: [{ role: 'assistant', content: 'Complete Rovo response' }]
      }
    },
    {
      agent: 'cline' as const,
      document: [{ role: 'assistant', content: 'Complete Cline response' }]
    }
  ])(
    'preserves the original $agent JSON document without requiring messages[]',
    async ({ agent, document }) => {
      const raw = JSON.stringify(document)
      mocks.rpc.mockResolvedValue(
        nativePage([], {
          sourceRecords: [{ byteOffset: 0, text: raw }],
          coverage: { ...nativePage([]).coverage, format: 'json', projection: 'raw-only' }
        })
      )

      const result = await readAiVaultConversationFleetContext(jsonVaultSession(agent), signal())

      expect(result).toMatchObject({
        sourceAgent: agent,
        sourceSessionId: 'vault-1',
        sourceHostId: 'runtime:archive',
        sourceRawTranscript: raw,
        sourceRawFormat: 'provider-json'
      })
      expect(result.sourceSummary).toBeUndefined()
      expect(result.transcript).toContain(raw)
      expect(mocks.rpc).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'archive' },
        'nativeChat.readTranscriptPage',
        expect.objectContaining({
          agent,
          sessionId: 'vault-1',
          transcriptPath: '/archive/conversation.json'
        }),
        expect.any(Object)
      )
    }
  )

  it.each([
    { sessionId: 'another-session' },
    { session_id: 'another-session' },
    { sessionId: 'vault-1', session_id: 'another-session' },
    { sessionId: 'another-session', session_id: 'vault-1' }
  ])('refuses JSON belonging to a different provider session: %j', async (identity) => {
    const raw = JSON.stringify({ ...identity, steps: [{ content: 'A different conversation' }] })
    mocks.rpc.mockResolvedValue(
      nativePage([], {
        sourceRecords: [{ byteOffset: 0, text: raw }],
        coverage: { ...nativePage([]).coverage, format: 'json', projection: 'raw-only' }
      })
    )

    await expect(
      readAiVaultConversationFleetContext(jsonVaultSession('devin'), signal())
    ).rejects.toThrow('The source JSON document belongs to another conversation.')
  })

  it.each(['null', '"A transcript label"', '42'])(
    'refuses scalar JSON as a provider conversation document: %s',
    async (raw) => {
      mocks.rpc.mockResolvedValue(
        nativePage([], {
          sourceRecords: [{ byteOffset: 0, text: raw }],
          coverage: { ...nativePage([]).coverage, format: 'json', projection: 'raw-only' }
        })
      )
      await expect(
        readAiVaultConversationFleetContext(jsonVaultSession('devin'), signal())
      ).rejects.toThrow('The source JSON document does not contain a complete conversation.')
    }
  )

  it('reassembles JSON fragments across byte pages without inserting bytes inside strings', async () => {
    const first = '{"messages":[{"role":"user","content":"large '
    const second = 'complete conversation"}]}'
    const cursor = transcriptCursor(first.length, first.length + second.length)
    mocks.rpc
      .mockResolvedValueOnce(
        nativePage([], {
          complete: false,
          cursor,
          sourceRecords: [{ byteOffset: 0, text: first }],
          coverage: {
            ...nativePage([]).coverage,
            format: 'json',
            projection: 'raw-only',
            toByteOffset: first.length,
            snapshotBytes: cursor.snapshotSize
          }
        })
      )
      .mockResolvedValueOnce(
        nativePage([], {
          sourceRecords: [{ byteOffset: first.length, text: second }],
          coverage: {
            ...nativePage([]).coverage,
            format: 'json',
            projection: 'raw-only',
            fromByteOffset: first.length,
            toByteOffset: cursor.snapshotSize,
            snapshotBytes: cursor.snapshotSize
          }
        })
      )
    expect((await readConversationFleetContext(row(), signal())).sourceRawTranscript).toBe(
      first + second
    )
  })

  it.each(['{"messages": [', '{"state":"not a conversation"}', '[]', '{"messages":{}}'])(
    'refuses incomplete Gemini JSON or documents without messages[] after byte paging: %s',
    async (raw) => {
      mocks.rpc.mockResolvedValue(
        nativePage([], {
          sourceRecords: [{ byteOffset: 0, text: raw }],
          coverage: { ...nativePage([]).coverage, format: 'json', projection: 'raw-only' }
        })
      )
      await expect(
        readAiVaultConversationFleetContext(jsonVaultSession('gemini'), signal())
      ).rejects.toThrow()
    }
  )

  it('uses the paired runtime that owns the selected SSH workspace', async () => {
    mocks.state.worktreesByRepo = {
      repo: [
        {
          id: 'workspace',
          repoId: 'repo',
          hostId: 'ssh:rented-mac',
          runtimeOwnerEnvironmentId: 'hub-1'
        }
      ]
    } as unknown as AppState['worktreesByRepo']
    mocks.state.agentStatusByPaneKey.pane.connectionId = 'rented-mac'
    mocks.rpc.mockResolvedValue(
      nativePage([message('remote', 'Owning SSH source')], {
        source: { connectionId: 'rented-mac' }
      })
    )
    const sshRow = row({
      hostId: 'ssh:rented-mac',
      sessionKey: providerSessionFolderKey({
        hostId: 'ssh:rented-mac',
        worktreeId: 'workspace',
        agent: 'codex',
        providerSession: provider
      })
    })
    expect((await readConversationFleetContext(sshRow, signal())).sourceRuntimeEnvironmentId).toBe(
      'hub-1'
    )
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'hub-1' },
      'nativeChat.readTranscriptPage',
      expect.objectContaining({ connectionId: 'rented-mac' }),
      expect.any(Object)
    )
  })

  it('refuses competing runtime owners of an SSH workspace without falling back locally', async () => {
    mocks.state.worktreesByRepo = {
      repo: ['hub-1', 'hub-2'].map((runtimeOwnerEnvironmentId) => ({
        id: 'workspace',
        repoId: 'repo',
        hostId: 'ssh:rented-mac',
        runtimeOwnerEnvironmentId
      }))
    } as unknown as AppState['worktreesByRepo']
    await expect(
      readConversationFleetContext(row({ hostId: 'ssh:rented-mac' }), signal())
    ).rejects.toThrow('more than one owning runtime')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('refuses claimed completeness when the byte coverage ends before the snapshot', async () => {
    mocks.rpc.mockResolvedValue(
      nativePage([message('partial', 'Only a prefix')], {
        coverage: { ...nativePage([]).coverage, toByteOffset: 99 }
      })
    )
    await expect(readConversationFleetContext(row(), signal())).rejects.toThrow(
      'complete original transcript records'
    )
  })

  it('supports folder workspaces with the explicit host even when another host has the same folder id', async () => {
    mocks.state.folderWorkspaces = [
      { id: 'folder-1', folderPath: '/local/wrong', executionHostId: 'local' },
      { id: 'folder-1', folderPath: '/owner/folder', executionHostId: 'runtime:owner' }
    ] as unknown as AppState['folderWorkspaces']
    mocks.rpc.mockResolvedValue({ ok: true, page: historyPage([item(1, 'Folder source')]) })
    mocks.state.unifiedTabsByWorktree['folder:folder-1'] =
      mocks.state.unifiedTabsByWorktree.workspace
    expect(
      (
        await readConversationFleetContext(
          { ...structuredRow(), worktreeId: 'folder:folder-1' },
          signal()
        )
      ).sourceWorkspacePath
    ).toBe('/owner/folder')
    expect(mocks.workspace).not.toHaveBeenCalled()
  })
})

describe('structured conversation capture', () => {
  it('loads all older pages in chronological order, retaining tool evidence with explicit preview warnings', async () => {
    const tool: AgentJournalRenderItem = {
      ...item(3, ''),
      body: {
        kind: 'tool-call',
        name: 'Read',
        input: { path: 'report.md' },
        state: 'completed',
        output: {
          head: 'Saved tool preview',
          truncated: true,
          byteLength: 90000,
          digest: 'digest-123'
        }
      }
    }
    mocks.rpc
      .mockResolvedValueOnce({
        ok: true,
        page: historyPage([item(2, 'Latest answer'), tool], true)
      })
      .mockResolvedValueOnce({ ok: true, page: historyPage([item(1, 'Original ask')]) })
    const result = await readConversationFleetContext(structuredRow(), signal())
    expect(result.transcript).toContain('Person:\nOriginal ask\n\nAgent:\nLatest answer')
    expect(result.transcript).toContain('Saved tool preview\n… (90000 bytes)')
    expect(result.sourceSummary).toBe('Latest answer')
    expect(result.sourceContextWarnings[0]).toContain('digest-123')
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'owner' },
      'agentSession.history',
      expect.objectContaining({ direction: 'before', cursor: { epoch: 'epoch-1', sequence: 2 } }),
      expect.any(Object)
    )
  })

  it('rejects journal resets between pages so separate epochs cannot be mixed', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ ok: true, page: historyPage([item(2, 'Latest')], true) })
      .mockResolvedValueOnce({
        ok: false,
        reset: 'epoch_changed',
        page: { ...historyPage([item(1, 'Replacement')]), epoch: 'epoch-2' }
      })
    await expect(readConversationFleetContext(structuredRow(), signal())).rejects.toThrow(
      'source conversation changed'
    )
  })

  it('pins the host journal fence and active turn without confusing provider ids', async () => {
    const running: AgentJournalRenderItem = {
      ...item(2, ''),
      body: { kind: 'status', text: '', turnLifecycle: { turnId: 'turn-17', state: 'running' } }
    }
    mocks.rpc.mockResolvedValue({
      ok: true,
      page: { ...historyPage([item(1, 'Ask'), running]), fence: 9 }
    })
    const result = await readConversationFleetContext(structuredRow(), signal())
    expect(result).toMatchObject({
      sourceSessionId: 'structured-1',
      sourceTurnId: 'turn-17',
      sourceRuntimeFence: 9,
      sourceRawFormat: 'structured-timeline-jsonl'
    })
    expect(result.sourceRawTranscript).toBe(
      [item(1, 'Ask'), running].map((value) => JSON.stringify(value)).join('\n')
    )
  })

  it('refuses a replaced structured tab before reading its new journal', async () => {
    mocks.state.unifiedTabsByWorktree.workspace[0].entityId = 'new-session'
    await expect(readConversationFleetContext(structuredRow(), signal())).rejects.toThrow(
      'source conversation changed'
    )
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
