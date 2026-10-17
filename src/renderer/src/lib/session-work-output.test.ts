import { beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { formatSessionWorkOutput, readSessionWorkOutput } from './session-work-output'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  tail: vi.fn(),
  transcript: vi.fn(),
  target: { kind: 'environment', environmentId: 'owning-host' },
  state: {
    agentStatusByPaneKey: {} as Record<
      string,
      {
        worktreeId?: string
        agentType?: string
        providerSession?: { id: string; transcriptPath?: string }
        lastAssistantMessage?: string
        connectionId?: string | null
      }
    >
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('./conversation-fleet-transcript-reader', () => ({
  readConversationFleetTranscript: mocks.transcript
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('./session-chain-client', () => ({ readTerminalTailFromHost: mocks.tail }))
vi.mock('./session-chain-support', () => ({
  workspaceRuntimeTarget: () => mocks.target,
  chainAbortError: () => new DOMException('Cancelled', 'AbortError')
}))
const chain = { worktreeId: 'work' }
const message = (role: NativeChatMessage['role'], text: string): NativeChatMessage => ({
  id: role,
  role,
  blocks: [{ type: 'text', text }],
  source: 'transcript',
  timestamp: 1
})
beforeEach(() => {
  vi.resetAllMocks()
  mocks.state.agentStatusByPaneKey = {
    pane: {
      worktreeId: 'work',
      agentType: 'codex',
      providerSession: { id: 'exact-session', transcriptPath: '/host/session.jsonl' },
      lastAssistantMessage: 'The file is ready.'
    }
  }
  mocks.tail.mockResolvedValue('raw terminal')
})

it('reads the exact source transcript on the owning host, preserving prose and file links', async () => {
  mocks.rpc.mockResolvedValue({
    messages: [
      message('user', 'Read input.txt'),
      message('assistant', '[Result](result.md) MARKER-742')
    ]
  })
  const signal = new AbortController().signal
  const output = await readSessionWorkOutput(chain, 'pane', 'handle', signal)
  expect(output).toBe('Person:\nRead input.txt\n\nAgent:\n[Result](result.md) MARKER-742')
  expect(mocks.rpc).toHaveBeenCalledWith(
    mocks.target,
    'nativeChat.readSession',
    expect.objectContaining({
      agent: 'codex',
      sessionId: 'exact-session',
      transcriptPath: '/host/session.jsonl'
    }),
    expect.objectContaining({ signal })
  )
  expect(mocks.tail).not.toHaveBeenCalled()
})

it('forwards the SSH source identity to the complete reader without a local transcript read', async () => {
  mocks.state.agentStatusByPaneKey.pane.connectionId = 'ssh-owner'
  mocks.transcript.mockResolvedValue({
    kind: 'file',
    file: { contentBase64: btoa('Newest remote conversation and result.md') }
  })
  const signal = new AbortController().signal
  expect(
    await readSessionWorkOutput({ ...chain, hostId: 'ssh:ssh-owner' }, 'pane', 'handle', signal)
  ).toContain('Newest remote conversation')
  expect(mocks.transcript).toHaveBeenCalledWith(
    expect.objectContaining({
      hostId: 'ssh:ssh-owner',
      runtimeEnvironmentId: 'owning-host',
      sessionId: 'exact-session',
      transcriptPath: '/host/session.jsonl'
    }),
    expect.any(String),
    signal,
    true
  )
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.tail).not.toHaveBeenCalled()
})

it('refuses a remote source whose owner changes while its summary is captured', async () => {
  mocks.state.agentStatusByPaneKey.pane.connectionId = 'ssh-owner'
  mocks.transcript.mockImplementation(async () => {
    mocks.state.agentStatusByPaneKey.pane.connectionId = 'replacement'
    return { kind: 'file', file: { contentBase64: btoa('Old host text') } }
  })
  await expect(
    readSessionWorkOutput(
      { ...chain, hostId: 'ssh:ssh-owner' },
      'pane',
      'handle',
      new AbortController().signal
    )
  ).rejects.toThrow('source conversation changed')
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.tail).not.toHaveBeenCalled()
})

it('uses the last hook reply when transcript is pending instead of terminal animation', async () => {
  mocks.rpc.mockResolvedValue({ status: 'pending' })
  expect(await readSessionWorkOutput(chain, 'pane', 'handle', new AbortController().signal)).toBe(
    'Latest agent response:\nThe file is ready.'
  )
  expect(mocks.tail).not.toHaveBeenCalled()
})

it("does not use another work location's session binding", async () => {
  mocks.state.agentStatusByPaneKey.pane.worktreeId = 'other-work'
  expect(
    await readSessionWorkOutput(chain, 'pane', 'handle', new AbortController().signal)
  ).toContain('Approximate terminal output')
  expect(mocks.rpc).not.toHaveBeenCalled()
})

it('refuses mixing context when the source session changes during the read', async () => {
  mocks.rpc.mockImplementation(async () => {
    mocks.state.agentStatusByPaneKey.pane = { providerSession: { id: 'replacement' } }
    return { messages: [message('assistant', 'old source')] }
  })
  await expect(
    readSessionWorkOutput(chain, 'pane', 'handle', new AbortController().signal)
  ).rejects.toThrow('source conversation changed')
  expect(mocks.tail).not.toHaveBeenCalled()
})

it('honors cancellation without falling through to another read', async () => {
  const controller = new AbortController()
  mocks.rpc.mockImplementation(async () => {
    controller.abort()
    throw new Error('aborted')
  })
  await expect(
    readSessionWorkOutput(chain, 'pane', 'handle', controller.signal)
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.tail).not.toHaveBeenCalled()
})

it('includes image references and actionable tool errors without internal reasoning or provider frames', () => {
  const tool = message('tool', '')
  tool.blocks = [
    { type: 'tool-call', name: 'Read', input: {} },
    { type: 'tool-result', output: 'Permission denied for input.txt', isError: true },
    { type: 'image-ref', path: '/work/chart.png' }
  ]
  expect(
    formatSessionWorkOutput([
      message('reasoning', 'private intermediate reasoning'),
      message('system', 'system setup'),
      tool
    ])
  ).toBe(
    'Tool:\nUsed tool: Read\nTool error: Permission denied for input.txt\nAttached image: /work/chart.png'
  )
})

it('retains successful tool data and arguments needed by the next worker', () => {
  const tool = message('tool', '')
  tool.blocks = [
    { type: 'tool-call', name: 'Read', input: { file_path: '/work/input.txt' } },
    { type: 'tool-result', output: 'EXACT-INPUT-742' }
  ]
  expect(formatSessionWorkOutput([tool])).toBe(
    'Tool:\nUsed tool: Read\nInput: {"file_path":"/work/input.txt"}\nTool result: EXACT-INPUT-742'
  )
})

it.each(['transcript', 'last response'])(
  'reads a finished conversation from %s without requiring its closed terminal',
  async (source) => {
    mocks.rpc.mockResolvedValue(
      source === 'transcript'
        ? { messages: [message('assistant', 'Finished report: result.md')] }
        : { status: 'pending' }
    )
    const resolve = vi.fn().mockRejectedValue(new Error('Terminal no longer exists'))
    const output = await readSessionWorkOutput(chain, 'pane', resolve, new AbortController().signal)
    expect(output).toContain(
      source === 'transcript' ? 'Finished report: result.md' : 'The file is ready.'
    )
    expect(resolve).not.toHaveBeenCalled()
    expect(mocks.tail).not.toHaveBeenCalled()
  }
)

it('resolves the owning terminal only when no conversation output is available', async () => {
  mocks.rpc.mockResolvedValue({ status: 'pending' })
  delete mocks.state.agentStatusByPaneKey.pane.lastAssistantMessage
  const resolve = vi.fn().mockResolvedValue('owning-terminal')
  const signal = new AbortController().signal
  expect(await readSessionWorkOutput(chain, 'pane', resolve, signal)).toContain('raw terminal')
  expect(resolve).toHaveBeenCalledTimes(1)
  expect(mocks.tail).toHaveBeenCalledWith(
    mocks.target,
    'owning-terminal',
    expect.any(Number),
    signal
  )
})
