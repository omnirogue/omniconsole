import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeTranscriptUploadBody } from '../../shared/employee-transcript-contract'
import type {
  SessionTranscriptBuild,
  SessionTranscriptSource
} from './session-transcript-deliverable'
import { TRANSCRIPT_FINAL_RETRY_INTERVAL_MS } from './transcript-final-retries'
import { TranscriptSequenceStore } from './transcript-sequence-store'
import { LedgerPaneRegistry, setActiveLedgerPaneRegistry } from '../session-ledger/ledger-identity'
import { transcriptUploadBody } from './transcript-upload-body'
import { TRANSCRIPT_UPLOAD_MAX_MESSAGES } from './transcript-upload-decision'
import {
  TRANSCRIPT_CHECKPOINT_INTERVAL_MS,
  TRANSCRIPT_CHECKPOINT_SETTLE_MS,
  TRANSCRIPT_QUIT_UPLOAD_TIMEOUT_MS,
  TRANSCRIPT_UPLOAD_TIMEOUT_MS,
  TranscriptUploader,
  type TranscriptUploadOptions
} from './transcript-uploader'

function built(text: string): SessionTranscriptBuild {
  const bytes = Buffer.from(text, 'utf8')
  return {
    kind: 'built',
    deliverable: {
      name: 'transcript.md',
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
      redactions: 0,
      messageCount: 2,
      truncatedBlocks: 0
    },
    earlierMessagesOmitted: false,
    omittedRecords: 0
  }
}

const identity = {
  sessionKey: 'tab-1:leaf-1',
  agent: 'claude',
  sessionId: 'ses-1',
  transcriptPath: '/home/me/.claude/projects/x/ses-1.jsonl',
  model: 'opus-5',
  cwd: '/home/me/Work/OmniRogue/Marketing'
}

function harness(overrides: Partial<ConstructorParameters<typeof TranscriptUploader>[0]> = {}) {
  const build = vi.fn(async (_source: SessionTranscriptSource, _signal?: AbortSignal) =>
    built('hello')
  )
  const upload = vi.fn(
    async (_body: EmployeeTranscriptUploadBody, _options: TranscriptUploadOptions) => ({
      ok: true as const,
      data: {}
    })
  )
  const reportHealth = vi.fn()
  const sleep = vi.fn(async (_ms: number) => undefined)
  const uploader = new TranscriptUploader({
    isSignedIn: () => true,
    build,
    upload,
    reportHealth,
    currentOwner: () => 'person-a',
    capturePrincipal: async () => ({ principal: 'person-a', isCurrent: () => true }),
    appVersion: () => '1.10.12',
    host: () => 'mac-1',
    sleep,
    scope: () => ({ company: 'OmniRogue', domain: 'Marketing' }),
    ...overrides
  })
  return { uploader, build, upload, reportHealth, sleep }
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(TRANSCRIPT_CHECKPOINT_SETTLE_MS)
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-13T10:00:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('TranscriptUploader', () => {
  it('uploads the whole session as a checkpoint after the settle window, stamped and scoped', async () => {
    const { uploader, build, upload, reportHealth } = harness()
    uploader.observe(identity)
    uploader.scheduleCheckpoint(identity.sessionKey)
    expect(upload).not.toHaveBeenCalled()
    await settle()
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        sessionId: 'ses-1',
        transcriptPath: identity.transcriptPath,
        model: 'opus-5',
        limit: TRANSCRIPT_UPLOAD_MAX_MESSAGES,
        clipToolPayloads: false
      }),
      expect.any(AbortSignal)
    )
    expect(upload).toHaveBeenCalledTimes(1)
    const body = upload.mock.calls[0]![0]
    expect(body).toMatchObject({
      session_id: 'ses-1',
      agent: 'claude',
      model: 'opus-5',
      cwd: identity.cwd,
      company: 'OmniRogue',
      domain: 'Marketing',
      started_at: '2026-09-13T10:00:00.000Z',
      ended_at: null,
      snapshot: 'checkpoint',
      seq: 1,
      app: 'omni-ide',
      app_version: '1.10.12',
      host: 'mac-1',
      message_count: 2,
      truncated_blocks: 0,
      content: 'hello'
    })
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'ok',
      code: 'checkpoint'
    })
  })

  it("carries the pane's ledger row id when it has one, and never a malformed or absent one", async () => {
    const registry = new LedgerPaneRegistry()
    const { entry } = registry.stamp('tab-1:leaf-1', { ptyId: 'pty-1' })
    setActiveLedgerPaneRegistry(registry)
    try {
      const { uploader, upload } = harness()
      uploader.observe(identity)
      uploader.scheduleCheckpoint(identity.sessionKey)
      uploader.observe({ ...identity, sessionKey: 'tab-2:leaf-2', sessionId: 'ses-2' })
      uploader.scheduleCheckpoint('tab-2:leaf-2')
      await settle()
      const bodies = upload.mock.calls.map(([body]) => body)
      expect(bodies.find((body) => body.session_id === 'ses-1')?.ledger_id).toBe(entry.ledgerId)
      expect(bodies.find((body) => body.session_id === 'ses-2')).not.toHaveProperty('ledger_id')
    } finally {
      setActiveLedgerPaneRegistry(null)
    }
    // A malformed id never travels, whatever the lookup answered.
    const facts = {
      agent: 'claude',
      sessionId: 'ses-3',
      ledgerId: 'not-a-ledger-id',
      model: null,
      cwd: null,
      startedAt: '2026-09-13T10:00:00.000Z',
      scope: { company: null, domain: null }
    }
    const stamp = {
      snapshot: 'checkpoint' as const,
      seq: 1,
      endedAt: null,
      appVersion: '1.10.12',
      host: 'mac-1'
    }
    expect(
      transcriptUploadBody(facts, stamp, { content: 'x', messageCount: 1, truncatedBlocks: 0 })
    ).not.toHaveProperty('ledger_id')
  })

  it('spaces checkpoints ten minutes apart and skips an unchanged session', async () => {
    const { uploader, build, upload } = harness()
    uploader.observe(identity)
    uploader.scheduleCheckpoint(identity.sessionKey)
    await settle()
    expect(upload).toHaveBeenCalledTimes(1)
    // A second Stop right away: nothing until the interval has passed.
    uploader.scheduleCheckpoint(identity.sessionKey)
    await settle()
    expect(build).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_CHECKPOINT_INTERVAL_MS)
    expect(build).toHaveBeenCalledTimes(2)
    // Same bytes → read, compared, not sent.
    expect(upload).toHaveBeenCalledTimes(1)
    build.mockResolvedValueOnce(built('hello and more'))
    uploader.scheduleCheckpoint(identity.sessionKey)
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_CHECKPOINT_INTERVAL_MS)
    expect(upload).toHaveBeenCalledTimes(2)
    expect(upload.mock.calls[1]![0]).toMatchObject({ seq: 2, content: 'hello and more' })
  })

  it('final uploads at once with ended_at, cancels a pending checkpoint and forgets the session', async () => {
    const { uploader, upload } = harness()
    uploader.observe(identity)
    uploader.scheduleCheckpoint(identity.sessionKey)
    vi.setSystemTime(new Date('2026-09-13T10:05:00.000Z'))
    await uploader.final(identity.sessionKey)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]![0]).toMatchObject({
      snapshot: 'final',
      seq: 1,
      started_at: '2026-09-13T10:00:00.000Z',
      ended_at: '2026-09-13T10:05:00.000Z'
    })
    expect(uploader.has(identity.sessionKey)).toBe(false)
    await settle()
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('uploads a withheld stub and reports protected_data when the redactor refuses', async () => {
    const { uploader, upload, reportHealth } = harness({
      build: vi.fn(async () => ({ kind: 'refused', redactions: 3 }) as SessionTranscriptBuild)
    })
    uploader.observe(identity)
    await uploader.final(identity.sessionKey)
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'protected_data',
      message: '3 redactions'
    })
    expect(upload).toHaveBeenCalledTimes(1)
    const body = upload.mock.calls[0]![0]
    expect(body.content).toBe(
      '[transcript withheld by the IDE redactor: 3 protected-data findings — session existed from 2026-09-13T10:00:00.000Z to 2026-09-13T10:00:00.000Z, agent claude, cwd /home/me/Work/OmniRogue/Marketing]'
    )
    expect(body.message_count).toBeUndefined()
    expect(body.snapshot).toBe('final')
  })

  it('sends nothing for an empty session and nothing at all when signed out', async () => {
    const signedOut = harness({ isSignedIn: () => false })
    signedOut.uploader.observe(identity)
    await signedOut.uploader.final(identity.sessionKey)
    expect(signedOut.build).not.toHaveBeenCalled()
    expect(signedOut.upload).not.toHaveBeenCalled()
    expect(signedOut.reportHealth).not.toHaveBeenCalled()

    const empty = harness({
      build: vi.fn(
        async () => ({ kind: 'error', code: 'transcript_empty' }) as SessionTranscriptBuild
      )
    })
    empty.uploader.observe(identity)
    empty.uploader.scheduleCheckpoint(identity.sessionKey)
    await settle()
    expect(empty.upload).not.toHaveBeenCalled()
    expect(empty.reportHealth).not.toHaveBeenCalled()
  })

  it('a final whose read failed records the session with a stub and keeps retrying the real final', async () => {
    const build = vi
      .fn(async (_source: SessionTranscriptSource, _signal?: AbortSignal) => built('late'))
      .mockResolvedValueOnce({ kind: 'error', code: 'transcript_empty' } as SessionTranscriptBuild)
    const { uploader, upload, reportHealth } = harness({ build })
    uploader.observe(identity)
    await uploader.final(identity.sessionKey)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]![0].content).toContain(
      '[transcript withheld: incomplete capture — read failed (transcript_empty)'
    )
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'incomplete_capture',
      message: 'transcript_empty'
    })
    expect(uploader.pendingFinalCount()).toBe(1)
    // Ten minutes later the file has been flushed: the real final goes up and the retry ends.
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_FINAL_RETRY_INTERVAL_MS)
    expect(upload).toHaveBeenCalledTimes(2)
    expect(upload.mock.calls[1]![0]).toMatchObject({ snapshot: 'final', seq: 2, content: 'late' })
    expect(uploader.pendingFinalCount()).toBe(0)
  })

  it('a final that the server refuses is retried every ten minutes for an hour, then reported', async () => {
    const upload = vi.fn(
      async (_body: EmployeeTranscriptUploadBody, _options: TranscriptUploadOptions) => ({
        ok: false as const,
        error: { code: 'server_error', message: 'boom', status: 503 }
      })
    )
    const { uploader, reportHealth } = harness({ upload })
    uploader.observe(identity)
    await uploader.final(identity.sessionKey)
    expect(uploader.pendingFinalCount()).toBe(1)
    for (let tick = 0; tick < 6; tick++) {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_FINAL_RETRY_INTERVAL_MS)
    }
    expect(uploader.pendingFinalCount()).toBe(0)
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'final_failed',
      message: 'claude session ses-1'
    })
    // finalizeAll no longer has anything to retry; a delivered final never lingers.
    await uploader.finalizeAll()
  })

  it('retries transport failures three times with backoff, then reports and gives up', async () => {
    const upload = vi.fn(
      async (_body: EmployeeTranscriptUploadBody, _options: TranscriptUploadOptions) => ({
        ok: false as const,
        error: { code: 'backoffice_unavailable', message: 'down' }
      })
    )
    const { uploader, reportHealth, sleep } = harness({ upload })
    uploader.observe(identity)
    await uploader.final(identity.sessionKey)
    expect(upload).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1_000, 4_000])
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'backoffice_unavailable',
      message: 'down'
    })
  })

  it('does not retry a 4xx refusal and names the status in the health code', async () => {
    const upload = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'no-employee-mapping', message: 'no employee', status: 409 }
    }))
    const { uploader, reportHealth } = harness({ upload })
    uploader.observe(identity)
    await uploader.final(identity.sessionKey)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'http_409',
      message: 'no employee'
    })
  })

  it('on 409 stale_snapshot jumps the sequence past the server once, and never marks stale bytes delivered', async () => {
    const stale = {
      ok: false as const,
      error: { code: 'stale_snapshot', message: 'newer', status: 409 }
    }
    const upload = vi
      .fn(
        async (_body: EmployeeTranscriptUploadBody, _options: TranscriptUploadOptions) =>
          ({ ok: true as const, data: {} }) as
            | { ok: true; data: Record<string, never> }
            | typeof stale
      )
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce({ ok: true, data: {} })
    const { uploader, reportHealth, build } = harness({ upload })
    uploader.observe(identity)
    uploader.scheduleCheckpoint(identity.sessionKey)
    await settle()
    expect(upload.mock.calls.map((call) => call[0].seq)).toEqual([1, 2])
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'ok',
      code: 'checkpoint'
    })

    // Stale twice: not delivered, so the next checkpoint re-reads and re-sends the same bytes.
    upload.mockResolvedValueOnce(stale).mockResolvedValueOnce(stale)
    reportHealth.mockClear()
    build.mockResolvedValue(built('changed'))
    uploader.scheduleCheckpoint(identity.sessionKey)
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_CHECKPOINT_INTERVAL_MS)
    expect(upload.mock.calls.map((call) => call[0].seq)).toEqual([1, 2, 3, 4])
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'stale_snapshot'
    })
    upload.mockClear()
    uploader.scheduleCheckpoint(identity.sessionKey)
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_CHECKPOINT_INTERVAL_MS)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]![0]).toMatchObject({ seq: 5, content: 'changed' })
  })

  it('when the transport gate refuses the document, sends the withheld stub instead', async () => {
    const refused = {
      ok: false as const,
      error: {
        code: 'invalid_request',
        message: 'contains protected data or exceeds its size limit'
      }
    }
    const upload = vi
      .fn(
        async (_body: EmployeeTranscriptUploadBody, _options: TranscriptUploadOptions) =>
          ({ ok: true as const, data: {} }) as
            | { ok: true; data: Record<string, never> }
            | typeof refused
      )
      .mockResolvedValueOnce(refused)
    const { uploader, reportHealth } = harness({ upload })
    uploader.observe(identity)
    await uploader.final(identity.sessionKey)
    expect(upload).toHaveBeenCalledTimes(2)
    expect(upload.mock.calls[1]![0]).toMatchObject({ seq: 2, snapshot: 'final' })
    expect(upload.mock.calls[1]![0].content).toContain(
      '[transcript withheld by the IDE redactor: protected data found by the send gate'
    )
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'protected_data'
    })
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'ok',
      code: 'final'
    })
  })

  it('uses the long timeout normally and one short aborted attempt at quit', async () => {
    const down = {
      ok: false as const,
      error: { code: 'backoffice_unavailable', message: 'down' }
    }
    const upload = vi.fn(
      async (_body: EmployeeTranscriptUploadBody, _options: TranscriptUploadOptions) => down
    )
    const { uploader, sleep, build } = harness({ upload })
    uploader.observe(identity)
    await uploader.finalizeAll()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]![1].timeoutMs).toBe(TRANSCRIPT_QUIT_UPLOAD_TIMEOUT_MS)
    expect(upload.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal)
    expect(build.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
    expect(sleep).not.toHaveBeenCalled()

    const normal = harness()
    normal.uploader.observe(identity)
    await normal.uploader.final(identity.sessionKey)
    expect(normal.upload.mock.calls[0]![1]).toMatchObject({
      timeoutMs: TRANSCRIPT_UPLOAD_TIMEOUT_MS,
      signal: expect.any(AbortSignal),
      expectedPrincipal: 'person-a'
    })
  })

  it('finalizes the previous session when the pane starts a new one, and all of them at quit', async () => {
    const { uploader, upload } = harness()
    uploader.observe(identity)
    uploader.observe({ ...identity, sessionId: 'ses-2' })
    await vi.advanceTimersByTimeAsync(0)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]![0]).toMatchObject({ session_id: 'ses-1', snapshot: 'final' })
    uploader.observe({ ...identity, sessionKey: 'tab-2:leaf-1', sessionId: 'ses-3' })
    await uploader.finalizeAll()
    expect(uploader.liveSessionKeys()).toEqual([])
    expect(upload.mock.calls.map((call) => call[0].session_id).sort()).toEqual([
      'ses-1',
      'ses-2',
      'ses-3'
    ])
  })

  it('picks up the worktree path from a later hook event and scopes the upload by it', async () => {
    const scope = vi.fn((cwd: string | null) =>
      cwd ? { company: 'OmniRogue', domain: 'Marketing' } : { company: null, domain: null }
    )
    const { uploader, upload } = harness({ scope })
    uploader.observe({ ...identity, cwd: null })
    uploader.observe({ ...identity, cwd: identity.cwd })
    await uploader.final(identity.sessionKey)
    expect(upload.mock.calls[0]![0]).toMatchObject({
      cwd: identity.cwd,
      company: 'OmniRogue',
      domain: 'Marketing'
    })
  })

  it('continues the sequence when the same provider session is resumed in a new pane', async () => {
    const sequences = new TranscriptSequenceStore(null)
    const first = harness({ sequences })
    first.uploader.observe(identity)
    await first.uploader.final(identity.sessionKey)
    expect(first.upload.mock.calls[0]![0].seq).toBe(1)

    const resumed = harness({ sequences })
    resumed.uploader.observe({ ...identity, sessionKey: 'tab-9:leaf-1' })
    await resumed.uploader.final('tab-9:leaf-1')
    expect(resumed.upload.mock.calls[0]![0].seq).toBe(2)
  })

  it('withholds an incomplete capture instead of uploading a partial as complete', async () => {
    const partial = { ...built('hello'), omittedRecords: 2 } as SessionTranscriptBuild
    const { uploader, upload, reportHealth } = harness({ build: vi.fn(async () => partial) })
    uploader.observe(identity)
    await uploader.final(identity.sessionKey)
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'incomplete_capture',
      message: '2 records omitted'
    })
    const body = upload.mock.calls[0]![0]
    expect(
      body.content.startsWith('[transcript withheld: incomplete capture — 2 records omitted — ')
    ).toBe(true)
    expect(body.message_count).toBeUndefined()

    const tail = { ...built('hello'), earlierMessagesOmitted: true } as SessionTranscriptBuild
    const tailed = harness({ build: vi.fn(async () => tail) })
    tailed.uploader.observe(identity)
    await tailed.uploader.final(identity.sessionKey)
    expect(tailed.upload.mock.calls[0]![0].content).toContain('earlier messages omitted')
  })

  it('finalizeAll waits for a final that was already in flight when the session was forgotten', async () => {
    let release: () => void = () => undefined
    const upload = vi.fn(
      (_body: EmployeeTranscriptUploadBody, _options: TranscriptUploadOptions) =>
        new Promise<{ ok: true; data: Record<string, never> }>((resolve) => {
          release = () => resolve({ ok: true, data: {} })
        })
    )
    const { uploader, reportHealth } = harness({ upload })
    uploader.observe(identity)
    const closing = uploader.final(identity.sessionKey)
    await vi.advanceTimersByTimeAsync(0)
    expect(uploader.has(identity.sessionKey)).toBe(false)
    let allDone = false
    const all = uploader.finalizeAll().then(() => {
      allDone = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(allDone).toBe(false)
    release()
    await Promise.all([closing, all])
    expect(allDone).toBe(true)
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'ok',
      code: 'final'
    })
  })

  it('at quit, a read aborted by the deadline still sends the tiny withheld stub on the same signal', async () => {
    const build = vi.fn(async (_source: SessionTranscriptSource, signal?: AbortSignal) => {
      // The reader's own `.catch` maps an abort to `unavailable`; a final must not skip on it.
      expect(signal).toBeInstanceOf(AbortSignal)
      return { kind: 'error', code: 'transcript_unavailable' } as SessionTranscriptBuild
    })
    const { uploader, upload, reportHealth } = harness({ build })
    uploader.observe(identity)
    await uploader.finalizeAll()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]![0]).toMatchObject({ snapshot: 'final', seq: 1 })
    expect(upload.mock.calls[0]![0].content).toContain('read failed (transcript_unavailable)')
    expect(upload.mock.calls[0]![1].timeoutMs).toBe(TRANSCRIPT_QUIT_UPLOAD_TIMEOUT_MS)
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'incomplete_capture',
      message: 'transcript_unavailable'
    })
  })

  it('at quit, a checkpoint in flight is aborted and its final starts at once', async () => {
    let releaseBuild: () => void = () => undefined
    const build = vi
      .fn(async (_source: SessionTranscriptSource, _signal?: AbortSignal) => built('hello'))
      .mockImplementationOnce(
        (_source, signal) =>
          new Promise<SessionTranscriptBuild>((resolve) => {
            releaseBuild = () => resolve(built('slow checkpoint'))
            signal?.addEventListener('abort', () => resolve(built('slow checkpoint')))
          })
      )
    const { uploader, upload } = harness({ build })
    uploader.observe(identity)
    uploader.scheduleCheckpoint(identity.sessionKey)
    await settle()
    expect(build).toHaveBeenCalledTimes(1)
    const quit = uploader.finalizeAll()
    await vi.advanceTimersByTimeAsync(0)
    await quit
    releaseBuild()
    // The checkpoint never uploaded; the final did, immediately.
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]![0]).toMatchObject({ snapshot: 'final', content: 'hello' })
  })

  it('a checkpoint in flight when the final starts never lands after it, and a later one is dropped', async () => {
    let releaseCheckpoint: () => void = () => undefined
    const build = vi
      .fn(async (_source: SessionTranscriptSource, _signal?: AbortSignal) => built('final text'))
      .mockImplementationOnce(
        () =>
          new Promise<SessionTranscriptBuild>((resolve) => {
            releaseCheckpoint = () => resolve(built('stale checkpoint'))
          })
      )
    const { uploader, upload } = harness({ build })
    uploader.observe(identity)
    uploader.scheduleCheckpoint(identity.sessionKey)
    await settle()
    expect(build).toHaveBeenCalledTimes(1)
    // The final arrives while the checkpoint's read is still pending; the slot is
    // chained synchronously, so the final is queued (and the checkpoint aborted).
    const closing = uploader.final(identity.sessionKey)
    releaseCheckpoint()
    await closing
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]![0]).toMatchObject({ snapshot: 'final', content: 'final text' })
    // A checkpoint scheduled before the final but firing after it does nothing.
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_CHECKPOINT_INTERVAL_MS)
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('holds a session observed under person A after the account switches to B, on every send and retry', async () => {
    let current = 'person-a'
    const capturePrincipal = vi.fn(async () => {
      const bound = current
      return { principal: bound, isCurrent: () => current === bound }
    })
    const { uploader, upload, reportHealth } = harness({
      capturePrincipal,
      currentOwner: () => current
    })
    uploader.observe(identity)
    uploader.scheduleCheckpoint(identity.sessionKey)
    await settle()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]![1]).toMatchObject({ expectedPrincipal: 'person-a' })
    expect(upload.mock.calls[0]![1].expectedPersonIsCurrent?.()).toBe(true)

    current = 'person-b'
    await uploader.final(identity.sessionKey)
    // Nothing left this machine as person B: the final is held and the session kept.
    expect(upload).toHaveBeenCalledTimes(1)
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'principal_changed'
    })
    expect(uploader.pendingFinalCount()).toBe(1)
    await uploader.finalizeAll()
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('re-captures under A after a held A -> B -> A when the first capture was taken under B', async () => {
    let current = 'person-a'
    const capturePrincipal = vi.fn(async () => {
      const bound = current
      return { principal: bound, isCurrent: () => current === bound }
    })
    const { uploader, upload, reportHealth } = harness({
      capturePrincipal,
      currentOwner: () => current
    })
    // Observed under A, but B is signed in by the time the first send captures.
    uploader.observe(identity)
    current = 'person-b'
    uploader.scheduleCheckpoint(identity.sessionKey)
    await settle()
    expect(upload).not.toHaveBeenCalled()
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'principal_changed'
    })
    expect(capturePrincipal).toHaveBeenCalledTimes(1)

    // A signs back in: the final re-captures (the B capture was cleared) and delivers as A.
    current = 'person-a'
    await uploader.final(identity.sessionKey)
    expect(capturePrincipal).toHaveBeenCalledTimes(2)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]![1]).toMatchObject({ expectedPrincipal: 'person-a' })
    expect(upload.mock.calls[0]![1].expectedPersonIsCurrent?.()).toBe(true)
  })

  it('re-captures under A after A signs out and back in (new epoch: the old A capture is never current again)', async () => {
    let current = 'person-a'
    let epoch = 1
    const capturePrincipal = vi.fn(async () => {
      const bound = current
      const boundEpoch = epoch
      return { principal: bound, isCurrent: () => current === bound && epoch === boundEpoch }
    })
    const { uploader, upload, reportHealth } = harness({
      capturePrincipal,
      currentOwner: () => current
    })
    uploader.observe(identity)
    uploader.scheduleCheckpoint(identity.sessionKey)
    await settle()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]![1]).toMatchObject({ expectedPrincipal: 'person-a' })

    // B signs in: held (the A capture is stale), nothing leaves as B.
    current = 'person-b'
    epoch = 2
    uploader.scheduleCheckpoint(identity.sessionKey)
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_CHECKPOINT_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'principal_changed'
    })

    // A signs back in under a fresh epoch: the stale capture would never be current
    // again, so the final must capture afresh and deliver as A.
    current = 'person-a'
    epoch = 3
    await uploader.final(identity.sessionKey)
    expect(upload).toHaveBeenCalledTimes(2)
    expect(upload.mock.calls[1]![1]).toMatchObject({ expectedPrincipal: 'person-a' })
    expect(upload.mock.calls[1]![1].expectedPersonIsCurrent?.()).toBe(true)
    // The held attempt cleared the stale capture without capturing as B; A's final captured afresh.
    expect(capturePrincipal).toHaveBeenCalledTimes(2)
  })

  it('a session whose first capture failed under A is never claimed by B after a switch', async () => {
    let current: string | null = 'person-a'
    let bearerAvailable = false
    const capturePrincipal = vi.fn(async () =>
      bearerAvailable && current ? { principal: current, isCurrent: () => true } : null
    )
    const { uploader, upload, reportHealth } = harness({
      capturePrincipal,
      currentOwner: () => current
    })
    uploader.observe(identity)
    // The bearer refresh fails under A: held, capture retried next run.
    uploader.scheduleCheckpoint(identity.sessionKey)
    await settle()
    expect(upload).not.toHaveBeenCalled()
    expect(capturePrincipal).toHaveBeenCalledTimes(1)
    // B signs in with a working credential: the session still belongs to A.
    current = 'person-b'
    bearerAvailable = true
    await uploader.final(identity.sessionKey)
    expect(upload).not.toHaveBeenCalled()
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'principal_changed'
    })
    // And a session observed while nobody was signed in is never claimed later either.
    current = null
    const orphan = harness({ capturePrincipal, currentOwner: () => current })
    orphan.uploader.observe({ ...identity, sessionKey: 'tab-3:leaf-1', sessionId: 'ses-3' })
    current = 'person-b'
    await orphan.uploader.final('tab-3:leaf-1')
    expect(orphan.upload).not.toHaveBeenCalled()
  })

  it('a send fenced by the transport (principal_mismatch) is held, never retried as another person', async () => {
    const upload = vi.fn(
      async (_body: EmployeeTranscriptUploadBody, _options: TranscriptUploadOptions) => ({
        ok: false as const,
        error: {
          code: 'principal_mismatch',
          message: 'Sign in as the person who activated this job.'
        }
      })
    )
    const { uploader, reportHealth, sleep } = harness({ upload })
    uploader.observe(identity)
    await uploader.final(identity.sessionKey)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'principal_changed'
    })
  })

  it('recovers from a lost local sequence in one retry using the seq the hub names on 409', async () => {
    const stale = {
      ok: false as const,
      error: {
        code: 'stale_snapshot',
        message: 'snapshot seq 1 is older than the stored seq 57',
        status: 409,
        // The hub's details carry the SUBMITTED seq, never the stored one.
        details: { session_id: 'ses-1', seq: 1 }
      }
    }
    const upload = vi
      .fn(
        async (_body: EmployeeTranscriptUploadBody, _options: TranscriptUploadOptions) =>
          ({ ok: true as const, data: {} }) as
            | { ok: true; data: Record<string, never> }
            | typeof stale
      )
      .mockResolvedValueOnce(stale)
    const sequences = new TranscriptSequenceStore(null)
    const { uploader, reportHealth } = harness({ upload, sequences })
    uploader.observe(identity)
    await uploader.finalizeAll()
    expect(upload.mock.calls.map((call) => call[0].seq)).toEqual([1, 58])
    expect(sequences.peek('claude', 'ses-1')).toBe(59)
    expect(reportHealth).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: 'stale_seq_unrecoverable' })
    )
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'ok',
      code: 'final'
    })
  })

  it('without a seq in the 409 body, bumps once and reports stale_seq_unrecoverable', async () => {
    const stale = {
      ok: false as const,
      error: { code: 'stale_snapshot', message: 'older', status: 409 }
    }
    const upload = vi
      .fn(
        async (_body: EmployeeTranscriptUploadBody, _options: TranscriptUploadOptions) =>
          ({ ok: true as const, data: {} }) as
            | { ok: true; data: Record<string, never> }
            | typeof stale
      )
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale)
    const { uploader, reportHealth } = harness({ upload })
    uploader.observe(identity)
    await uploader.final(identity.sessionKey)
    expect(upload.mock.calls.map((call) => call[0].seq)).toEqual([1, 2])
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'stale_seq_unrecoverable'
    })
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'transcript_upload',
      status: 'error',
      code: 'stale_snapshot'
    })
  })
})
