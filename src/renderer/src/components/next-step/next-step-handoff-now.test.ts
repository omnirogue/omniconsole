// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { handoffSessionNow } from './next-step-handoff-now'
import { emptyNextStepDraft, type NextStepDraft } from '../../../../shared/next-step-draft'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionFollowUpRule } from '../../../../shared/session-follow-up-rule'
import { readPendingHandoff, updatePendingSessionHandoff } from '../handoffs/handoff-request-memory'
import type { ExactHandoffFile } from '../../../../shared/console-handoff-contract'

const f = vi.hoisted(() => ({
  me: vi.fn(),
  read: vi.fn(),
  capture: vi.fn(),
  send: vi.fn(),
  upload: vi.fn(),
  resolve: vi.fn(),
  readExact: vi.fn(),
  files: new Map<string, ExactHandoffFile>(),
  scope: 'sal',
  priorSteps: ['existing-verification', 'saved-human-handoff']
}))
vi.mock('@/lib/conversation-fleet-context-source', () => ({
  resolveSidebarSource: () => ({
    sourceKind: 'provider',
    sourceHostId: 'local',
    sourceAgent: 'codex',
    sourceSessionId: 'session-1'
  })
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ scope: f.scope, steps: f.priorSteps }) }
}))
vi.mock('@/lib/console-account-scope', () => ({
  selectConsoleAccountScope: (s: { scope: string }) => s.scope
}))
vi.mock('@/components/companies/companies-client', () => ({
  companiesApi: () => ({ me: f.me }),
  companiesData: (r: unknown) => r
}))
vi.mock('@/lib/session-chain-support', () => ({
  workspaceRuntimeTarget: () => ({ kind: 'local' })
}))
vi.mock('@/lib/next-session-launch', () => ({
  createTerminalWaitDependencies: () => ({ resolveSource: f.resolve })
}))
vi.mock('@/lib/session-work-output', () => ({ readSessionWorkOutput: f.read }))
vi.mock('@/lib/session-outcome-connection', () => ({
  sessionOutcomeConnection: () => ({
    negotiate: async () => ({
      target: { kind: 'local' },
      capabilities: { handoffFolders: 1, handoffAttachments: 1 },
      call: f.capture
    })
  })
}))
vi.mock('@/lib/session-follow-up-io', () => ({
  createFollowUpHostIo: () => ({ readExact: f.readExact }),
  createFollowUpHubIo: () => ({
    sendCardless: f.send,
    uploadThreadFile: f.upload,
    isRejected: () => false
  })
}))
vi.mock('@/lib/session-follow-up-completion', () => ({
  summaryFile: async (name: string, text: string) => ({
    name,
    contentBase64: btoa(text),
    size: text.length,
    sha256: 'a'.repeat(64)
  })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const session = {
  rowKey: 'row',
  paneKey: 'pane',
  worktreeId: 'workspace',
  hostId: 'local',
  label: 'Current work'
} as SidebarSession
function draft(): NextStepDraft {
  return {
    ...emptyNextStepDraft(),
    outcomes: [
      {
        id: 'one',
        instructions: 'Check the result and continue from here.',
        steps: [],
        finish: {
          kind: 'person',
          personId: 'emp_test',
          personName: 'Test',
          action: 'edit',
          disposition: 'ownership'
        }
      }
    ]
  }
}
beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  localStorage.clear()
  f.files.clear()
  f.scope = 'sal'
  f.me.mockResolvedValue({ user: { id: 'user_sal' } })
  f.resolve.mockResolvedValue({ handle: 'live-terminal' })
  f.read.mockResolvedValue('Person: Create a report. Agent: The report is in progress.')
  f.send.mockResolvedValue({ thread_id: 'hth_verified' })
  f.readExact.mockImplementation(async (path: string) => {
    const file = f.files.get(path)
    if (!file) {
      throw new Error('Captured file is missing')
    }
    return file
  })
  f.capture.mockImplementation(
    async (_method, input: { handoff: SessionFollowUpRule; summary: string }) => {
      const handoff: SessionFollowUpRule = {
        ...input.handoff,
        capturedAt: 1,
        ...(input.handoff.includeSummary ? { summaryMarkdown: input.summary } : {}),
        files: input.handoff.includeSummary
          ? [
              {
                sourcePath: null,
                name: `session-${input.handoff.recipients[0]!.operationId}.md`,
                size: input.summary.length,
                sha256: 'a'.repeat(64)
              }
            ]
          : []
      }
      if (input.handoff.transcriptSource) {
        const file = {
          name: 'transcript.md',
          size: 4,
          sha256: 'b'.repeat(64),
          contentBase64: btoa('chat')
        }
        const sourcePath = '/workspace/transcript.md'
        f.files.set(sourcePath, file)
        handoff.transcriptFile = file
        handoff.files!.push({
          sourcePath,
          generatedKind: 'transcript',
          name: file.name,
          sha256: file.sha256,
          size: file.size
        })
      }
      return { handoff }
    }
  )
})
it('hands off a running, unfiled session with exact instructions and current context without changing its saved steps', async () => {
  const before = [...f.priorSteps]
  await handoffSessionNow(session, draft(), '/workspace')
  expect(f.capture).toHaveBeenCalledWith(
    'sessionChain.captureHandoff',
    expect.objectContaining({
      worktreeId: 'workspace',
      handoff: expect.objectContaining({ taskId: null, destinationDirectory: '/workspace' })
    }),
    { timeoutMs: 60_000 }
  )
  const input = f.send.mock.calls[0]![0]
  expect(input.note).toBe('Check the result and continue from here.')
  expect(input.recipient).toBe('emp_test')
  expect(atob(input.attachments[0].contentBase64)).toContain('source work may still be running')
  expect(atob(input.attachments[0].contentBase64)).toContain('Create a report')
  expect(f.priorSteps).toEqual(before)
  expect(localStorage.length).toBe(0)
  expect(f.capture.mock.calls[0]![1].handoff.transcriptSource).toBeUndefined()
})
it('sends the redacted transcript as one more attachment when the owner ticked it', async () => {
  const input = draft()
  input.handoff = { ...input.handoff, includeTranscript: true }
  await handoffSessionNow(session, input, '/workspace')
  expect(f.capture.mock.calls[0]![1].handoff.transcriptSource).toEqual({
    kind: 'provider',
    hostId: 'local',
    agent: 'codex',
    sessionId: 'session-1'
  })
  const attachments = f.send.mock.calls[0]![0].attachments
  expect(attachments.map((file: { name: string }) => file.name)).toEqual([
    expect.stringMatching(/^session-.*\.md$/),
    'transcript.md'
  ])
  expect(atob(attachments[1].contentBase64)).toBe('chat')
  expect(localStorage.length).toBe(0)
})
it('shares complete history without requiring a summary attachment', async () => {
  const input = draft()
  input.handoff = { ...input.handoff, includeSummary: false, includeTranscript: true }
  await handoffSessionNow(session, input, '/workspace')
  expect(f.send.mock.calls[0]![0].attachments).toEqual([f.files.get('/workspace/transcript.md')])
  expect(localStorage.length).toBe(0)
})
it('does not retain or send a package when complete history capture refuses protected data', async () => {
  f.capture.mockRejectedValue(new Error('Secrets remain.'))
  const input = draft()
  input.handoff = { ...input.handoff, includeTranscript: true }
  await expect(handoffSessionNow(session, input, '/workspace')).rejects.toThrow('Secrets remain.')
  expect(f.capture).toHaveBeenCalledTimes(1)
  expect(f.send).not.toHaveBeenCalled()
  expect(localStorage.length).toBe(0)
})
it('retries the original transcript bytes and operation after the source history changes', async () => {
  vi.useFakeTimers()
  const input = draft()
  input.handoff.includeTranscript = true
  f.send.mockRejectedValue(new Error('connection lost'))
  const first = expect(handoffSessionNow(session, input, '/workspace')).rejects.toThrow(
    'connection lost'
  )
  await vi.runAllTimersAsync()
  await first
  const request = f.send.mock.calls[0]![0]
  const saved = localStorage.getItem(localStorage.key(0)!)!
  expect(saved).not.toContain('contentBase64')
  expect(saved).toContain('/workspace/transcript.md')
  f.capture.mockRejectedValue(new Error('New source history must not be captured'))
  f.read.mockResolvedValue('Later conversation and different capture timestamp')
  f.send.mockResolvedValue({ thread_id: 'hth_original' })
  await handoffSessionNow(session, input, '/workspace')
  expect(f.capture).toHaveBeenCalledTimes(1)
  expect(f.send.mock.lastCall![0]).toEqual(request)
  expect(localStorage.length).toBe(0)
})
it('clears an already saved delivery receipt without rereading or resending its transcript', async () => {
  vi.useFakeTimers()
  const input = draft()
  input.handoff.includeTranscript = true
  f.send.mockRejectedValue(new Error('connection lost'))
  const first = expect(handoffSessionNow(session, input, '/workspace')).rejects.toThrow(
    'connection lost'
  )
  await vi.runAllTimersAsync()
  await first
  const target = 'session-now:user_sal:local:row'
  const pending = readPendingHandoff('sal', target)!
  if (pending.kind !== 'session') {
    throw new Error('Expected session request')
  }
  pending.body.rule.recipients[0] = {
    ...pending.body.rule.recipients[0]!,
    delivery: 'sent',
    threadId: 'hth_original'
  }
  updatePendingSessionHandoff('sal', target, pending)
  f.files.clear()
  f.send.mockClear()
  f.readExact.mockClear()
  await handoffSessionNow(session, input, '/workspace')
  expect(f.send).not.toHaveBeenCalled()
  expect(f.readExact).not.toHaveBeenCalled()
  expect(localStorage.length).toBe(0)
})
it('retries an uncertain response using the original capture and operation, even when the session has since changed', async () => {
  vi.useFakeTimers()
  f.send.mockRejectedValue(new Error('connection lost'))
  const first = handoffSessionNow(session, draft(), '/workspace')
  const rejected = expect(first).rejects.toThrow('connection lost')
  await vi.runAllTimersAsync()
  await rejected
  const operation = f.send.mock.calls[0]![0].operationId
  const attachment = f.send.mock.calls[0]![0].attachments
  expect(localStorage.length).toBe(1)
  f.read.mockResolvedValue('New work after handoff')
  f.send.mockResolvedValue({ thread_id: 'hth_original' })
  await handoffSessionNow(session, draft(), '/workspace')
  expect(f.capture).toHaveBeenCalledTimes(1)
  expect(f.send.mock.lastCall![0]).toMatchObject({
    operationId: operation,
    attachments: attachment
  })
  expect(localStorage.length).toBe(0)
})
it('does not send when the signed person changes during capture', async () => {
  f.capture.mockImplementationOnce(async (_method, input) => {
    f.scope = 'other'
    return { handoff: input.handoff }
  })
  await expect(handoffSessionNow(session, draft(), '/workspace')).rejects.toThrow(
    'signed-in person changed'
  )
  expect(f.send).not.toHaveBeenCalled()
})
it('does not bypass selected agent or review steps', async () => {
  const input = draft()
  input.outcomes![0]!.steps = [
    {
      id: 'agent',
      kind: 'handoff',
      actor: { agent: 'codex' },
      presetId: 'implement',
      instructions: 'Fix first'
    }
  ]
  await expect(handoffSessionNow(session, input, '/workspace')).rejects.toThrow('When done')
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.send).not.toHaveBeenCalled()
})

it('does not require a closed source terminal when the finished conversation can be read', async () => {
  f.resolve.mockRejectedValue(new Error('Terminal no longer exists'))
  f.read.mockResolvedValue('Agent: Finished report at result.md')
  await handoffSessionNow(session, draft(), '/workspace')
  expect(f.read).toHaveBeenCalledWith(
    session,
    'pane',
    expect.any(Function),
    expect.any(AbortSignal)
  )
  expect(f.resolve).not.toHaveBeenCalled()
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(atob(f.send.mock.calls[0]![0].attachments[0].contentBase64)).toContain(
    'Finished report at result.md'
  )
})
