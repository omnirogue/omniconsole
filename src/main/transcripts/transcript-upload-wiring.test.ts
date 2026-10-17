import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  statusListeners: new Set<(enriched: Record<string, unknown>) => void>(),
  teardownListeners: new Set<(paneKey: string) => void>(),
  reportAppHealth: vi.fn(),
  observe: vi.fn(),
  scheduleCheckpoint: vi.fn(),
  final: vi.fn(async () => undefined)
}))

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    subscribeEnrichedStatus: (listener: (enriched: Record<string, unknown>) => void) => {
      mocks.statusListeners.add(listener)
      return () => mocks.statusListeners.delete(listener)
    }
  }
}))
vi.mock('../ipc/pty/pane/key-state', () => ({
  registerPaneKeyTeardownListener: (listener: (paneKey: string) => void) => {
    mocks.teardownListeners.add(listener)
    return () => mocks.teardownListeners.delete(listener)
  }
}))
vi.mock('../app-health/app-health', () => ({ reportAppHealth: mocks.reportAppHealth }))
vi.mock('../host/electron-omni-console-mcp-auth', () => ({
  isElectronOmniConsoleMcpSignedIn: () => true
}))
vi.mock('../backoffice/console-employee-transcript-client', () => ({
  uploadEmployeeTranscript: vi.fn(),
  captureTranscriptPrincipal: vi.fn(async () => null),
  currentTranscriptOwner: vi.fn(() => null)
}))
vi.mock('./transcript-uploader', () => ({
  TranscriptUploader: class {
    observe = mocks.observe
    scheduleCheckpoint = mocks.scheduleCheckpoint
    final = mocks.final
    finalizeAll = vi.fn(async () => undefined)
  }
}))

const { startTranscriptUploads } = await import('./transcript-upload-wiring')

function emit(overrides: Record<string, unknown>): void {
  for (const listener of mocks.statusListeners) {
    listener({
      paneKey: 'tab-1:leaf-1',
      connectionId: null,
      worktreeId: 'repo::/Users/me/Work/OmniRogue/Marketing',
      providerSession: { key: 'session_id', id: 'ses-1', transcriptPath: '/t.jsonl' },
      payload: { state: 'working', prompt: '', agentType: 'claude', model: 'opus-5' },
      ...overrides
    })
  }
}

describe('transcript upload wiring', () => {
  beforeEach(() => {
    mocks.observe.mockClear()
    mocks.scheduleCheckpoint.mockClear()
    mocks.final.mockClear()
    mocks.reportAppHealth.mockClear()
    startTranscriptUploads({})
  })

  it('observes the session with its cwd and checkpoints on a turn end, not on a tool ping', () => {
    emit({ hookEventName: 'PreToolUse' })
    expect(mocks.observe).toHaveBeenCalledWith({
      sessionKey: 'tab-1:leaf-1',
      agent: 'claude',
      sessionId: 'ses-1',
      transcriptPath: '/t.jsonl',
      model: 'opus-5',
      cwd: '/Users/me/Work/OmniRogue/Marketing'
    })
    expect(mocks.scheduleCheckpoint).not.toHaveBeenCalled()
    emit({ hookEventName: 'Stop', payload: { state: 'done', prompt: '', agentType: 'claude' } })
    emit({ hookEventName: 'SubagentStop' })
    expect(mocks.scheduleCheckpoint).toHaveBeenCalledTimes(2)
    expect(mocks.final).not.toHaveBeenCalled()
  })

  it('routes a genuine session end to final, and pane teardown too', () => {
    emit({ hookEventName: 'SessionEnd' })
    emit({
      hookEventName: 'session_end',
      payload: { state: 'done', prompt: '', agentType: 'grok' }
    })
    expect(mocks.final).toHaveBeenCalledTimes(2)
    expect(mocks.scheduleCheckpoint).not.toHaveBeenCalled()
    for (const listener of mocks.teardownListeners) {
      listener('tab-1:leaf-1')
    }
    expect(mocks.final).toHaveBeenCalledTimes(3)
  })

  it('skips SSH and replayed statuses', () => {
    emit({ connectionId: 'ssh-1', hookEventName: 'Stop' })
    emit({ isReplay: true, hookEventName: 'Stop' })
    expect(mocks.observe).not.toHaveBeenCalled()
  })

  it('makes the Gemini gap visible once per session instead of skipping silently', () => {
    const gemini = { state: 'done', prompt: '', agentType: 'gemini' }
    emit({ hookEventName: 'Stop', payload: gemini })
    emit({ hookEventName: 'Stop', payload: gemini })
    emit({
      hookEventName: 'Stop',
      payload: gemini,
      providerSession: { key: 'session_id', id: 'ses-2' }
    })
    expect(mocks.observe).not.toHaveBeenCalled()
    expect(mocks.reportAppHealth).toHaveBeenCalledTimes(2)
    expect(mocks.reportAppHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'unsupported_agent',
      message: 'gemini session ses-1'
    })
  })
})
