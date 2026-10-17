import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExactHandoffFile } from '../../../shared/console-handoff-contract'
import type { SessionChain, SessionChainHandoffStep } from '../../../shared/session-chain-types'
import type { SessionFollowUpRule } from '../../../shared/session-follow-up-rule'

function exact(name: string, text: string): ExactHandoffFile {
  const bytes = Buffer.from(text)
  return {
    name,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentBase64: bytes.toString('base64')
  }
}

const mocks = vi.hoisted(() => {
  class SourceSessionFailedError extends Error {}
  return {
    SourceSessionFailedError,
    waitForSourceSessionStop: vi.fn(),
    waitForExit: vi.fn(),
    waitForPaneAgentWorking: vi.fn(),
    readSessionWorkOutput: vi.fn(),
    persist: vi.fn(),
    hostOffline: vi.fn(),
    waitForHost: vi.fn(),
    waitForRecheck: vi.fn(),
    host: { exists: vi.fn(), size: vi.fn(), readExact: vi.fn() },
    hub: { upload: vi.fn(), send: vi.fn(), isRejected: vi.fn() },
    prepareRoutes: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn() }
  }
})

vi.mock('@/lib/next-session-launch', () => ({
  SourceSessionFailedError: mocks.SourceSessionFailedError,
  createTerminalWaitDependencies: (_target: unknown, _request: unknown, signal?: AbortSignal) => ({
    waitForExit: (handle: string, timeoutMs?: number) =>
      mocks.waitForExit(handle, timeoutMs, signal)
  }),
  waitForSourceSessionStop: mocks.waitForSourceSessionStop
}))
vi.mock('@/lib/session-chain-support', () => ({
  chainAbortError: () => new DOMException('cancelled', 'AbortError'),
  sleepUnlessAborted: async () => undefined,
  waitForPaneAgentWorking: mocks.waitForPaneAgentWorking,
  withResolveRetry: (deps: unknown) => deps,
  workspaceRuntimeTarget: () => ({ kind: 'local' })
}))
vi.mock('@/lib/session-work-output', () => ({
  readSessionWorkOutput: mocks.readSessionWorkOutput
}))
vi.mock('@/lib/session-chain-prompt', () => ({ SESSION_CHAIN_INPUT_LINE_LIMIT: 120 }))
vi.mock('@/lib/session-chain-registry', () => ({ persistSessionChainOrThrow: mocks.persist }))
vi.mock('@/lib/session-follow-up-io', () => ({
  createFollowUpHostIo: () => mocks.host,
  createFollowUpHubIo: () => mocks.hub,
  followUpHostLabel: () => 'devbox',
  isFollowUpHostOffline: mocks.hostOffline,
  waitForFollowUpHost: mocks.waitForHost,
  waitForFollowUpRecheck: mocks.waitForRecheck
}))
vi.mock('@/components/handoffs/handoff-client', () => ({
  capturePickedHandoffFile: async (file: File) => exact(file.name, await file.text()),
  handoffApi: () => ({ prepareRoutes: mocks.prepareRoutes })
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

const { runSessionFollowUpStep } = await import('./session-follow-up-step')

const report = exact('report.md', 'final report')
const idle = { source: { handle: 'term_1' }, exited: false }

function untilAborted<T>(signal: AbortSignal | undefined, value: T): Promise<T> {
  return new Promise((resolve) => signal?.addEventListener('abort', () => resolve(value)))
}

function rule(extra: Partial<SessionFollowUpRule> = {}): SessionFollowUpRule {
  return {
    revision: 1,
    taskId: 'btk_abcd1234',
    taskTitle: 'Webinar intro',
    sessionLabel: 'Draft',
    recipients: [
      { employeeId: 'emp_iris', name: 'Iris', operationId: 'fu_iris_op', delivery: 'pending' }
    ],
    action: 'review',
    deliverables: { kind: 'files', paths: ['/w/report.md'] },
    includeSummary: false,
    note: 'Please review',
    savedAt: 1,
    ...extra
  }
}

function handoffOf(chain: SessionChain): SessionFollowUpRule {
  return (chain.steps[0] as SessionChainHandoffStep).handoff
}

function setup(handoff: SessionFollowUpRule) {
  let chain: SessionChain = {
    id: 'chn_f',
    workspacePath: '/w',
    worktreeId: 'folder:f1',
    hostId: 'ssh:devbox',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: 'row',
    auto: true,
    steps: [{ kind: 'handoff', id: 'step_h', status: 'queued', handoff }],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  }
  const access = {
    getChain: () => chain,
    update: (patch: Partial<SessionChain>) => {
      chain = { ...chain, ...patch, updatedAt: chain.updatedAt + 1 }
      return chain
    },
    persist: async () => undefined
  }
  const step = () => chain.steps[0] as SessionChainHandoffStep
  const persisted = () => mocks.persist.mock.calls.map(([saved]) => saved as SessionChain)
  return {
    access,
    step,
    persisted,
    get chain() {
      return chain
    },
    set: (next: SessionChain) => {
      chain = next
    }
  }
}

describe('follow-up step', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.persist.mockResolvedValue(undefined)
    mocks.hostOffline.mockReturnValue(false)
    mocks.waitForHost.mockResolvedValue(undefined)
    mocks.waitForRecheck.mockResolvedValue(undefined)
    mocks.waitForSourceSessionStop.mockResolvedValue(idle)
    mocks.waitForExit.mockImplementation((_handle: string, _ms: number, signal?: AbortSignal) =>
      untilAborted(signal, { status: 'running', exitCode: null })
    )
    mocks.waitForPaneAgentWorking.mockResolvedValue(true)
    mocks.host.exists.mockResolvedValue(true)
    mocks.host.size.mockResolvedValue(report.size)
    mocks.host.readExact.mockResolvedValue(report)
    mocks.hub.isRejected.mockReturnValue(false)
    mocks.hub.upload.mockImplementation(async (_task: string, file: ExactHandoffFile) => ({
      path: `handoffs/${file.name}`,
      sha256: file.sha256
    }))
    mocks.hub.send.mockResolvedValue({ thread_id: 'hth_iris' })
    // The routing rule runs for real in its own tests; here it stands aside so these cases keep
    // testing what they were written for — the wait, the capture and the delivery.
    mocks.prepareRoutes.mockImplementation(async (request: { pins: unknown[]; memo: string }) => ({
      ok: true,
      data: { git: null, pins: request.pins, memoLines: [], refused: [], manifest: [] }
    }))
  })

  it("delivers at a stop when the run's own manifest declares its files", async () => {
    const manifest = exact('manifest.md', '- `report.md`')
    mocks.host.readExact.mockImplementation(async (path: string) =>
      path.endsWith('manifest.md') ? manifest : report
    )
    const run = setup(
      rule({ deliverables: { kind: 'manifest', manifestPath: '/w/out/manifest.md' } })
    )
    await runSessionFollowUpStep(run.access, ['tab-1:leaf-1'], new AbortController().signal)

    expect(mocks.hub.send).toHaveBeenCalledTimes(1)
    expect(run.persisted().some((saved) => handoffOf(saved).readyAt !== undefined)).toBe(false)
    expect(run.step().handoff.files?.[0]).toMatchObject({
      sourcePath: '/w/out/report.md',
      name: 'report.md'
    })
    expect(run.step().status).toBe('delivered')
  })

  it('treats a stop at the prompt as the end of a turn: named files wait for a clean exit or a confirmation', async () => {
    const run = setup(rule())
    let exit: ((wait: unknown) => void) | undefined
    mocks.waitForPaneAgentWorking
      .mockResolvedValueOnce(true)
      .mockImplementation((_pane: string, signal: AbortSignal) => untilAborted(signal, false))
    mocks.waitForExit
      .mockImplementationOnce((_handle: string, _ms: number, signal?: AbortSignal) =>
        untilAborted(signal, { status: 'running', exitCode: null })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            exit = resolve
          })
      )
    const running = runSessionFollowUpStep(
      run.access,
      ['tab-1:leaf-1'],
      new AbortController().signal
    )

    await vi.waitFor(() => expect(mocks.waitForExit).toHaveBeenCalledTimes(2))
    expect(mocks.hub.upload).not.toHaveBeenCalled()
    expect(mocks.hub.send).not.toHaveBeenCalled()
    // Ready at the first stop, withdrawn when the next turn started, ready again at the second.
    expect(run.persisted().map((saved) => handoffOf(saved).readyAt !== undefined)).toEqual([
      true,
      false,
      true
    ])
    expect(mocks.waitForSourceSessionStop).toHaveBeenCalledTimes(2)
    expect(mocks.waitForExit).toHaveBeenLastCalledWith('term_1', 10 * 60 * 1000, expect.anything())

    exit?.({ status: 'exited', exitCode: 0 })
    await running
    expect(mocks.hub.send).toHaveBeenCalledTimes(1)
    expect(run.step().status).toBe('delivered')
    expect(run.step().handoff.readyAt).toBeUndefined()
  })

  it('keeps waiting for the next stop while a file is missing, then sends once confirmed finished', async () => {
    const run = setup(rule({ includeSummary: true, confirmedAt: 7 }))
    mocks.host.exists.mockResolvedValueOnce(false).mockResolvedValue(true)
    mocks.readSessionWorkOutput.mockResolvedValue('All done: report.md written.')
    await runSessionFollowUpStep(run.access, ['tab-1:leaf-1'], new AbortController().signal)

    expect(mocks.waitForSourceSessionStop).toHaveBeenCalledTimes(2)
    expect(mocks.waitForPaneAgentWorking).toHaveBeenCalledTimes(1)
    const waiting = run.persisted().find((saved) => {
      return handoffOf(saved).waitingForFiles?.includes('report.md')
    })
    expect(waiting?.state).toBe('waiting')
    expect(run.persisted().some((saved) => handoffOf(saved).readyAt !== undefined)).toBe(false)
    expect(mocks.hub.send).toHaveBeenCalledTimes(1)
    expect(mocks.hub.send.mock.calls[0]?.[0]).toMatchObject({
      recipient: 'emp_iris',
      operationId: 'fu_iris_op',
      fileVersions: [
        { path: 'handoffs/report.md', sha256: report.sha256 },
        { path: 'handoffs/draft-final-summary.md', sha256: expect.any(String) }
      ]
    })
    expect(run.chain).toMatchObject({ currentIndex: 1, state: 'done' })
    expect(run.step()).toMatchObject({
      status: 'delivered',
      handoff: { recipients: [{ delivery: 'sent', threadId: 'hth_iris' }] }
    })
    expect(run.step().handoff.summaryMarkdown).toContain('All done: report.md written.')
    expect(mocks.toast.success).toHaveBeenCalledWith('Sent to Iris · Review')
  })

  it('resumes a captured rule after a restart without waiting on the session again', async () => {
    const run = setup(
      rule({
        capturedAt: 5,
        files: [
          {
            sourcePath: '/w/report.md',
            name: 'report.md',
            sha256: report.sha256,
            size: report.size
          }
        ],
        recipients: [{ ...rule().recipients[0]!, delivery: 'sending' }]
      })
    )
    await runSessionFollowUpStep(run.access, ['tab-1:leaf-1'], new AbortController().signal)
    expect(mocks.waitForSourceSessionStop).not.toHaveBeenCalled()
    expect(mocks.host.readExact).toHaveBeenCalledWith('/w/report.md')
    expect(mocks.hub.send).toHaveBeenCalledTimes(1)
    expect(run.step().status).toBe('delivered')
  })

  it('records a host-observed bad end as a failed run and sends nothing', async () => {
    const run = setup(rule())
    mocks.waitForSourceSessionStop.mockRejectedValue(
      new mocks.SourceSessionFailedError(
        'The source session exited with code 1; the next session was not started.'
      )
    )
    await expect(
      runSessionFollowUpStep(run.access, ['tab-1:leaf-1'], new AbortController().signal)
    ).rejects.toThrow('The session did not reach a clean finish, so no request was sent.')
    expect(run.step().handoff.exception).toMatchObject({ code: 'run-failed' })
    expect(mocks.hub.upload).not.toHaveBeenCalled()
    expect(mocks.hub.send).not.toHaveBeenCalled()
  })

  it('reports a wait with no verdict as unverifiable, checks again on its own, then continues', async () => {
    const run = setup(rule({ confirmedAt: 7 }))
    mocks.waitForSourceSessionStop
      .mockRejectedValueOnce(new Error('runtime_unavailable'))
      .mockResolvedValue(idle)
    await runSessionFollowUpStep(run.access, ['tab-1:leaf-1'], new AbortController().signal)

    const unverified = run.persisted().find((saved) => saved.state === 'failed')
    expect(handoffOf(unverified!).exception).toMatchObject({
      code: 'unverifiable',
      detail: 'runtime_unavailable'
    })
    expect(unverified?.error).toContain('Whether the session finished could not be verified')
    expect(unverified?.error).not.toContain('clean finish')
    expect(mocks.waitForRecheck).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chn_f' }),
      expect.any(AbortSignal),
      15_000
    )
    expect(run.step().status).toBe('delivered')
    expect(run.step().handoff.exception).toBeUndefined()
  })

  it('never lets a run that was stopped for a retry write its older record back', async () => {
    const run = setup(rule({ confirmedAt: 7 }))
    let found: ((value: boolean) => void) | undefined
    mocks.host.exists.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          found = resolve
        })
    )
    const controller = new AbortController()
    const running = runSessionFollowUpStep(run.access, ['tab-1:leaf-1'], controller.signal)
    await vi.waitFor(() => expect(mocks.host.exists).toHaveBeenCalledTimes(1))
    const writesBefore = mocks.persist.mock.calls.length

    // A retry took over: same step and revision, a re-keyed person, and the old run stopped.
    controller.abort()
    const retried = {
      ...run.step().handoff,
      recipients: [{ ...rule().recipients[0]!, operationId: 'fu_new_key_1' }]
    }
    run.set({ ...run.chain, steps: [{ ...run.step(), handoff: retried }] })
    found?.(true)

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.persist.mock.calls.length).toBe(writesBefore)
    expect(run.step().handoff.recipients[0]?.operationId).toBe('fu_new_key_1')
    expect(run.step().handoff.capturedAt).toBeUndefined()
    expect(mocks.hub.upload).not.toHaveBeenCalled()
  })

  it('treats a file over the size limit as an exception, never a partial package', async () => {
    const run = setup(rule({ confirmedAt: 7 }))
    mocks.host.size.mockResolvedValue(10 * 1024 * 1024 + 1)
    await expect(
      runSessionFollowUpStep(run.access, ['tab-1:leaf-1'], new AbortController().signal)
    ).rejects.toThrow('report.md is over the 10 MB limit, so no request was sent.')
    expect(run.step().handoff.exception).toMatchObject({ code: 'file-too-large' })
    expect(mocks.hub.send).not.toHaveBeenCalled()
  })

  it('lets a cancel that races completion win before any request leaves', async () => {
    const run = setup(rule({ confirmedAt: 7 }))
    mocks.hub.upload.mockImplementation(async (_task: string, file: ExactHandoffFile) => {
      run.set({ ...run.chain, state: 'cancelled' })
      return { path: `handoffs/${file.name}`, sha256: file.sha256 }
    })
    await expect(
      runSessionFollowUpStep(run.access, ['tab-1:leaf-1'], new AbortController().signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.hub.send).not.toHaveBeenCalled()
    expect(run.chain.state).toBe('cancelled')
  })

  it('shows an offline SSH host and continues when it reconnects', async () => {
    const run = setup(rule({ confirmedAt: 7 }))
    mocks.waitForSourceSessionStop
      .mockRejectedValueOnce(new Error('The session pane could not be found.'))
      .mockResolvedValue(idle)
    mocks.hostOffline.mockReturnValueOnce(true).mockReturnValue(false)
    await runSessionFollowUpStep(run.access, ['tab-1:leaf-1'], new AbortController().signal)
    const offline = run.persisted().find((saved) => saved.state === 'failed')
    expect(handoffOf(offline!).exception).toMatchObject({
      code: 'host-unreachable',
      subject: 'devbox'
    })
    expect(offline?.error).toContain('devbox is not connected. The run there is unverifiable')
    expect(mocks.waitForHost).toHaveBeenCalledTimes(1)
    expect(mocks.waitForRecheck).not.toHaveBeenCalled()
    expect(run.step().status).toBe('delivered')
    expect(run.step().handoff.exception).toBeUndefined()
  })

  it('does nothing when a duplicate run reaches a step that already delivered', async () => {
    const run = setup(rule({ confirmedAt: 7 }))
    await runSessionFollowUpStep(run.access, ['tab-1:leaf-1'], new AbortController().signal)
    mocks.hub.send.mockClear()
    await runSessionFollowUpStep(run.access, ['tab-1:leaf-1'], new AbortController().signal)
    expect(mocks.hub.send).not.toHaveBeenCalled()
    expect(run.chain.currentIndex).toBe(1)
  })
})
