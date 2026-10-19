import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExactHandoffFile } from '../../../shared/console-handoff-contract'
import type * as HandoffClient from '@/components/handoffs/handoff-client'
import type { CapturedConversationFleetContext } from './conversation-fleet-context'
import type { SidebarSession } from './sidebar-sessions'
import { prepareConversationFleetInputs } from './conversation-fleet-inputs'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), scope: 'sal', upload: vi.fn(), list: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/store/conversation-fleet-store', () => ({ conversationFleetScope: () => mocks.scope }))
vi.mock('./console-workflow-client', () => ({
  workflowData: (result: { ok: boolean; data?: unknown }) => {
    if (!result.ok) {
      throw new Error('Upload refused')
    }
    return result.data
  }
}))
vi.mock('@/components/handoffs/handoff-client', async (importOriginal) => ({
  ...(await importOriginal<typeof HandoffClient>()),
  handoffApi: () => ({ uploadFile: mocks.upload, taskFiles: mocks.list })
}))

const snapshotId = 'a2000000-0000-4000-8000-000000000001'
const fileId = 'a2000000-0000-4000-8000-000000000002'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const context: CapturedConversationFleetContext = {
  title: 'Review my changes',
  sourceSessionId: 'session-1',
  sourceWorkspacePath: '/owner/work',
  sourceHostId: 'runtime:owner',
  sourceAgent: 'codex',
  sourceKind: 'provider',
  transcript: `Person:\nOriginal intent\n\nAgent:\n${'Complete historical detail. '.repeat(3000)}`,
  sourceRawTranscript: '{"role":"user","text":"Original intent"}\n',
  sourceRawFormat: 'provider-jsonl',
  sourceContextWarnings: []
}
const session: SidebarSession = {
  rowKey: 'row-1',
  sessionKey: null,
  worktreeId: 'source-worktree',
  hostId: 'runtime:owner',
  tabId: null,
  paneKey: null,
  kind: 'terminal',
  label: 'Review my changes',
  workspaceLabel: 'Source',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}
const selection = { paths: ['/owner/work/new.txt'], includeDirtyTracked: true }
let saved: { rel: string; size: number; sha256: string }[]
let snapshot: Record<string, unknown>
let transcriptResult: Record<string, unknown>

const TRANSCRIPT_BODY = '# Session transcript\n\n- Agent: codex\n'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.scope = 'sal'
  saved = []
  snapshot = {
    snapshotId,
    baseCommit: 'a'.repeat(40),
    files: [
      {
        id: fileId,
        name: 'new.txt',
        size: 5,
        sha256: sha('hello'),
        targetPath: 'src/new.txt',
        executable: true
      }
    ],
    deletions: ['src/old.txt'],
    warnings: [],
    source: { connectionId: null }
  }
  mocks.rpc.mockImplementation(async (_target: unknown, method: string) => {
    if (method === 'files.captureFleetSource') {
      return snapshot
    }
    if (method === 'files.readFleetSourceChunk') {
      return {
        contentBase64: Buffer.from('hello').toString('base64'),
        nextOffset: 5,
        complete: true
      }
    }
    if (method === 'files.releaseFleetSource') {
      return { ok: true }
    }
    if (method === 'transcripts.buildDeliverable') {
      return transcriptResult
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  transcriptResult = {
    name: 'transcript-session-1-20260913.md',
    contentBase64: Buffer.from(TRANSCRIPT_BODY).toString('base64'),
    sha256: sha(TRANSCRIPT_BODY),
    size: Buffer.byteLength(TRANSCRIPT_BODY),
    messageCount: 12,
    truncatedBlocks: 0,
    earlierMessagesOmitted: false,
    omittedRecords: 0
  }
  mocks.list.mockImplementation(async () => ({
    ok: true,
    data: { files: saved.map((file) => ({ ...file })) }
  }))
  mocks.upload.mockImplementation(async ({ file }: { file: ExactHandoffFile }) => {
    const rel = `uploads/${file.name}`
    saved.push({ rel, size: file.size, sha256: file.sha256 })
    return { ok: true, data: { path: rel, sha256: file.sha256 } }
  })
})

describe('conversation fleet input preparation', () => {
  it('persists the full long conversation and raw records with exact frozen workspace pins', async () => {
    const result = await prepareConversationFleetInputs({
      taskId: 'btk_test1',
      session,
      context,
      selection
    })
    const uploaded = mocks.upload.mock.calls.map(([request]) => request.file as ExactHandoffFile)
    expect(Buffer.from(uploaded[0].contentBase64, 'base64').toString()).toBe(context.transcript)
    expect(Buffer.from(uploaded[1].contentBase64, 'base64').toString()).toBe(
      context.sourceRawTranscript
    )
    expect(result.transcriptDigest).toBe(sha(context.transcript))
    expect(result.context.transcript.length).toBeLessThan(2000)
    expect(result.context.transcript).toContain('EXACT FROZEN INPUT FILES')
    expect(result.context.transcript).toContain(uploaded[0].name)
    expect(result.sourceFiles[2]).toEqual({
      kind: 'task_file',
      task_id: 'btk_test1',
      target_path: 'src/new.txt',
      executable: true,
      file: {
        rel: `uploads/${uploaded[2].name}`,
        name: uploaded[2].name,
        size_bytes: 5,
        sha256: sha('hello')
      }
    })
    expect(result).toMatchObject({ baseCommit: 'a'.repeat(40), sourceDeletions: ['src/old.txt'] })
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner' },
      'files.captureFleetSource',
      {
        worktree: session.worktreeId,
        paths: selection.paths,
        includeDirtyTracked: true,
        expectedConnectionId: null
      },
      expect.any(Object)
    )
    expect(mocks.rpc).toHaveBeenCalledWith(
      expect.anything(),
      'files.releaseFleetSource',
      { snapshotId },
      expect.anything()
    )
  })

  it('preserves source capture caveats as an attached file and review warnings', async () => {
    snapshot.warnings = ['One submodule is not included.']
    const input = {
      ...context,
      sourceContextWarnings: ['A tool preview references an external blob.']
    }
    const result = await prepareConversationFleetInputs({
      taskId: 'btk_test1',
      session,
      context: input,
      selection
    })
    expect(result.warnings).toEqual([
      ...input.sourceContextWarnings,
      'One submodule is not included.'
    ])
    const notes = mocks.upload.mock.calls.find(([request]) =>
      request.file.name.startsWith('source-capture-notes')
    )?.[0].file
    expect(Buffer.from(notes.contentBase64, 'base64').toString()).toContain(
      input.sourceContextWarnings[0]
    )
    expect(result.context.transcript).toContain(notes.name)
  })

  it('keeps a provider JSON document as an exact JSON attachment', async () => {
    const raw = '{"messages":[{"role":"assistant","content":"Full document"}]}'
    await prepareConversationFleetInputs({
      taskId: 'btk_test1',
      session,
      context: {
        ...context,
        sourceRawFormat: 'provider-json',
        sourceRawTranscript: raw
      },
      selection
    })
    const file = mocks.upload.mock.calls.find(([request]) =>
      request.file.name.startsWith('source-transcript')
    )?.[0].file
    expect(file.name.endsWith('.json')).toBe(true)
    expect(Buffer.from(file.contentBase64, 'base64').toString()).toBe(raw)
  })

  it('rejects source-host mismatch before uploading any bytes', async () => {
    snapshot.source = { connectionId: 'another-mac' }
    await expect(
      prepareConversationFleetInputs({ taskId: 'btk_test1', session, context, selection })
    ).rejects.toThrow('execution host')
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mocks.rpc).toHaveBeenCalledWith(
      expect.anything(),
      'files.releaseFleetSource',
      { snapshotId },
      expect.anything()
    )
  })

  it('captures an SSH source through its owning paired runtime', async () => {
    snapshot.source = { connectionId: 'rented-mac' }
    await prepareConversationFleetInputs({
      taskId: 'btk_test1',
      session,
      context: {
        ...context,
        sourceHostId: 'ssh:rented-mac',
        sourceRuntimeEnvironmentId: 'paired-owner'
      },
      selection
    })
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'paired-owner' },
      'files.captureFleetSource',
      expect.objectContaining({ expectedConnectionId: 'rented-mac' }),
      expect.anything()
    )
  })

  it('rejects changed chunk content instead of pinning the wrong source version', async () => {
    mocks.rpc.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'files.captureFleetSource') {
        return snapshot
      }
      if (method === 'files.readFleetSourceChunk') {
        return {
          contentBase64: Buffer.from('wrong').toString('base64'),
          nextOffset: 5,
          complete: true
        }
      }
      return { ok: true }
    })
    await expect(
      prepareConversationFleetInputs({ taskId: 'btk_test1', session, context, selection })
    ).rejects.toThrow('failed verification')
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('gives an actionable refusal for an older source runtime', async () => {
    mocks.rpc.mockRejectedValue(
      Object.assign(new Error('Method unavailable'), { code: 'method_not_found' })
    )
    await expect(
      prepareConversationFleetInputs({ taskId: 'btk_test1', session, context, selection })
    ).rejects.toThrow('Update Orca on the source host')
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('rechecks saved file pins before returning a reviewable package', async () => {
    mocks.list.mockResolvedValue({ ok: true, data: { files: [] } })
    await expect(
      prepareConversationFleetInputs({ taskId: 'btk_test1', session, context, selection })
    ).rejects.toThrow('saved source file changed')
  })

  it('stops further uploads when the signed-in person changes', async () => {
    mocks.upload.mockImplementationOnce(async ({ file }: { file: ExactHandoffFile }) => {
      mocks.scope = 'another-person'
      return { ok: true, data: { path: `uploads/${file.name}`, sha256: file.sha256 } }
    })
    await expect(
      prepareConversationFleetInputs({ taskId: 'btk_test1', session, context, selection })
    ).rejects.toThrow('signed-in person changed')
    expect(mocks.upload).toHaveBeenCalledTimes(1)
  })

  it('counts transcripts and source notes toward the total file limit before uploading', async () => {
    snapshot.files = Array.from({ length: 30 }, (_, index) => ({
      id: fileId,
      name: `file-${index}.txt`,
      size: 5,
      sha256: sha('hello'),
      targetPath: `files/file-${index}.txt`,
      executable: false
    }))
    const input = {
      ...context,
      sourceContextWarnings: ['A retained tool payload is only a preview.']
    }
    await expect(
      prepareConversationFleetInputs({ taskId: 'btk_test1', session, context: input, selection })
    ).rejects.toThrow('32-file limit')
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('reuses verified digest-named uploads when preparing the same captured inputs again', async () => {
    const first = await prepareConversationFleetInputs({
      taskId: 'btk_test1',
      session,
      context,
      selection
    })
    const second = await prepareConversationFleetInputs({
      taskId: 'btk_test1',
      session,
      context,
      selection
    })
    expect(second.sourceFiles).toEqual(first.sourceFiles)
    expect(mocks.upload).toHaveBeenCalledTimes(3)
  })

  it('pins only the exact assistant answer and declared source files for a direct person handoff', async () => {
    const input = {
      ...context,
      sourceSummary: '  Final verified assistant answer.\n\nKeep every byte.\n'
    }
    snapshot.deliverables = { kind: 'files', paths: ['src/new.txt'] }
    snapshot.deliverablePaths = ['src/new.txt']
    snapshot.files = [
      ...(snapshot.files as object[]),
      {
        id: fileId,
        name: 'other.txt',
        size: 5,
        sha256: sha('hello'),
        targetPath: 'other.txt',
        executable: false
      }
    ]
    const result = await prepareConversationFleetInputs({
      taskId: 'btk_test1',
      session,
      context: input,
      selection,
      handoff: {
        includeSummary: true,
        deliverables: { kind: 'files', paths: ['/owner/work/src/new.txt'] }
      }
    })
    const summary = mocks.upload.mock.calls.find(([request]) =>
      request.file.name.startsWith('source-assistant-answer')
    )?.[0].file
    expect(Buffer.from(summary.contentBase64, 'base64').toString()).toBe(input.sourceSummary)
    expect(result.sourceSummaryFile?.file.sha256).toBe(sha(input.sourceSummary))
    expect(result.sourceSummaryFile?.target_path).toBeUndefined()
    expect(result.sourceSummaryFile).toBe(
      result.sourceFiles.find((pin) => pin.file.name === summary.name)
    )
    expect(result.sourceDeliverables).toEqual({ kind: 'files', paths: ['src/new.txt'] })
    expect(result.sourceDeliverableFiles?.map((pin) => pin.target_path)).toEqual(['src/new.txt'])
    expect(mocks.rpc).toHaveBeenCalledWith(
      expect.anything(),
      'files.captureFleetSource',
      expect.objectContaining({ deliverables: { kind: 'files', paths: ['src/new.txt'] } }),
      expect.anything()
    )
  })

  it('passes only explicitly named manifests to the source host and preserves their declared file set', async () => {
    snapshot.deliverables = { kind: 'manifest', manifestPath: 'src/manifest.md' }
    snapshot.deliverablePaths = ['src/manifest.md', 'src/new.txt']
    snapshot.files = [
      ...(snapshot.files as object[]),
      {
        id: fileId,
        name: 'manifest.md',
        size: 5,
        sha256: sha('hello'),
        targetPath: 'src/manifest.md',
        executable: false
      }
    ]
    const result = await prepareConversationFleetInputs({
      taskId: 'btk_test1',
      session,
      context,
      selection,
      handoff: {
        includeSummary: false,
        deliverables: { kind: 'manifest', manifestPath: '/owner/work/src/manifest.md' }
      }
    })
    expect(result.sourceDeliverables).toEqual(snapshot.deliverables)
    expect(result.sourceDeliverablePaths).toEqual(['src/new.txt'])
    expect(result.sourceDeliverableFiles?.map((pin) => pin.target_path).sort()).toEqual([
      'src/manifest.md',
      'src/new.txt'
    ])
    expect(result.sourceSummaryFile).toBeUndefined()
  })

  it('does not substitute a full conversation when the requested assistant summary is unavailable', async () => {
    await expect(
      prepareConversationFleetInputs({
        taskId: 'btk_test1',
        session,
        context,
        selection,
        handoff: { includeSummary: true, deliverables: null }
      })
    ).rejects.toThrow('No assistant summary is available yet')
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('honors Include summary off even when the captured assistant answer exists', async () => {
    snapshot.deliverables = { kind: 'files', paths: [] }
    snapshot.deliverablePaths = []
    const result = await prepareConversationFleetInputs({
      taskId: 'btk_test1',
      session,
      context: { ...context, sourceSummary: 'Unrequested answer' },
      selection,
      handoff: { includeSummary: false, deliverables: null }
    })
    expect(result.sourceSummaryFile).toBeUndefined()
    expect(
      mocks.upload.mock.calls.some(([request]) =>
        request.file.name.startsWith('source-assistant-answer')
      )
    ).toBe(false)
  })

  it('refuses oversized exact summaries before creating any remote files', async () => {
    await expect(
      prepareConversationFleetInputs({
        taskId: 'btk_test1',
        session,
        context: { ...context, sourceSummary: 'é'.repeat(524289) },
        selection,
        handoff: { includeSummary: true, deliverables: null }
      })
    ).rejects.toThrow('1 MiB limit')
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('refuses a capture response missing a requested declared deliverable', async () => {
    snapshot.deliverables = { kind: 'files', paths: ['missing.txt'] }
    snapshot.deliverablePaths = ['missing.txt']
    await expect(
      prepareConversationFleetInputs({
        taskId: 'btk_test1',
        session,
        context,
        selection,
        handoff: { includeSummary: false, deliverables: { kind: 'files', paths: ['missing.txt'] } }
      })
    ).rejects.toThrow('declared handoff file')
    expect(mocks.upload).not.toHaveBeenCalled()
  })
})

describe('the session transcript as a handoff deliverable', () => {
  const withTranscript = {
    taskId: 'btk_test1',
    session,
    context,
    selection,
    includeTranscript: true,
    capturedAt: '2026-09-13T09:30:00.000Z'
  }

  it('asks the source host to build it, never sending messages off that host', async () => {
    await prepareConversationFleetInputs(withTranscript)
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner' },
      'transcripts.buildDeliverable',
      {
        agent: 'codex',
        sessionId: 'session-1',
        capturedAt: '2026-09-13T09:30:00.000Z',
        expectedConnectionId: null
      },
      expect.anything()
    )
  })

  it('attaches the verified transcript at its fixed target path', async () => {
    const result = await prepareConversationFleetInputs(withTranscript)
    const pin = result.sourceFiles.find(
      (file) => file.target_path === 'handoff/transcript.md'
    )
    expect(pin).toBeDefined()
    expect(pin?.file.sha256).toBe(sha(TRANSCRIPT_BODY))
    expect(result.sourceTranscript).toEqual({ file: pin, messageCount: 12 })
  })

  it('blocks the dispatch when the host refuses the transcript', async () => {
    transcriptResult = { reason: 'transcript_contains_protected_data', redactions: 2 }
    await expect(prepareConversationFleetInputs(withTranscript)).rejects.toThrow(
      /contains 2 values the redactor treats as a secret/
    )
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('refuses bytes that do not match the digest the host declared', async () => {
    transcriptResult = { ...transcriptResult, sha256: sha('something else') }
    await expect(prepareConversationFleetInputs(withTranscript)).rejects.toThrow(
      /failed verification/
    )
  })

  it('tells the person to update a source host that lacks the transcript method', async () => {
    mocks.rpc.mockRejectedValue(
      Object.assign(new Error('Method unavailable'), { code: 'method_not_found' })
    )
    await expect(prepareConversationFleetInputs(withTranscript)).rejects.toThrow(
      'Update Orca on the source host'
    )
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('asks for no transcript when the owner did not tick it', async () => {
    const result = await prepareConversationFleetInputs({
      ...withTranscript,
      includeTranscript: false
    })
    expect(result.sourceTranscript).toBeUndefined()
    expect(
      mocks.rpc.mock.calls.some(([, method]) => method === 'transcripts.buildDeliverable')
    ).toBe(false)
  })
})
