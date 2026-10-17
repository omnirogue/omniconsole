import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExactHandoffFile, HandoffSend } from '../../../shared/console-handoff-contract'
import {
  normalizeSessionChains,
  type SessionChain,
  type SessionChainHandoffStep
} from '../../../shared/session-chain-types'
import type { SessionFollowUpRule } from '../../../shared/session-follow-up-rule'
import type { SessionFollowUpDraft } from './session-follow-up-commands'

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
    upsert: vi.fn(),
    remove: vi.fn(),
    waitForStop: vi.fn(),
    waitForExit: vi.fn(),
    working: vi.fn(),
    host: { exists: vi.fn(), size: vi.fn(), readExact: vi.fn() },
    hub: { upload: vi.fn(), send: vi.fn(), isRejected: vi.fn() },
    prepareRoutes: vi.fn(async (request: { pins: unknown[] }) => ({
      ok: true,
      data: { git: null, pins: request.pins, memoLines: [], refused: [], manifest: [] }
    })),
    runs: [] as Promise<unknown>[],
    ids: { next: 0 }
  }
})

vi.mock('@/lib/session-chain-client', () => ({
  upsertSessionChainOnHost: mocks.upsert,
  removeSessionChainOnHost: mocks.remove,
  readTerminalTailFromHost: async () => 'final output'
}))
vi.mock('@/lib/next-session-launch', () => ({
  SourceSessionFailedError: mocks.SourceSessionFailedError,
  createTerminalWaitDependencies: (_target: unknown, _request: unknown, signal?: AbortSignal) => ({
    waitForExit: (handle: string, timeoutMs?: number) =>
      mocks.waitForExit(handle, timeoutMs, signal)
  }),
  waitForSourceSessionStop: mocks.waitForStop
}))
vi.mock('@/lib/session-chain-support', () => ({
  LOCAL_CHAIN_TARGET: { kind: 'local' },
  randomChainId: (prefix: string) => `${prefix}_${String((mocks.ids.next += 1)).padStart(12, '0')}`,
  chainAbortError: () => new DOMException('cancelled', 'AbortError'),
  sleepUnlessAborted: async () => undefined,
  waitForPaneAgentWorking: mocks.working,
  withResolveRetry: (deps: unknown) => deps,
  workspaceRuntimeTarget: () => ({ kind: 'local' })
}))
vi.mock('@/lib/session-chain-prompt', () => ({ SESSION_CHAIN_INPUT_LINE_LIMIT: 120 }))
vi.mock('@/lib/session-follow-up-io', () => ({
  createFollowUpHostIo: () => mocks.host,
  createFollowUpHubIo: () => mocks.hub,
  followUpHostLabel: () => '',
  isFollowUpHostOffline: () => false,
  waitForFollowUpHost: async () => undefined,
  waitForFollowUpRecheck: async () => undefined
}))
vi.mock('@/components/handoffs/handoff-client', () => ({
  capturePickedHandoffFile: async (file: File) => exact(file.name, await file.text()),
  // The routing rule runs for real in its own tests; here it stands aside so these cases keep
  // testing what they were written for — Send now, retry and re-capture.
  handoffApi: () => ({ prepareRoutes: mocks.prepareRoutes })
}))
vi.mock('sonner', () => ({ toast: { success: () => undefined, error: () => undefined } }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      getKnownWorktreeById: (id: string) => (id === 'folder:f1' ? { path: '/w' } : undefined)
    })
  }
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
// Why: the real step runs under a minimal runner, so edits, retries and confirmations meet a live run.
vi.mock('@/lib/session-chain-runner', async () => {
  const registry = await import('@/lib/session-chain-registry')
  const { runSessionFollowUpStep } = await import('@/lib/session-follow-up-step')
  const stopSessionChainRun = vi.fn((id: string) => {
    const entry = registry.getSessionChainEntry(id)
    entry?.controller?.abort()
    if (entry) {
      entry.controller = null
    }
  })
  const runSessionChainNow = vi.fn((id: string) => {
    const entry = registry.getSessionChainEntry(id)
    if (!entry) {
      return
    }
    entry.controller?.abort()
    const controller = new AbortController()
    entry.controller = controller
    const access = {
      getChain: () => registry.getSessionChainEntry(id)?.chain ?? null,
      update: (patch: Partial<SessionChain>) => registry.updateSessionChain(id, patch),
      persist: registry.persistSessionChain
    }
    mocks.runs.push(
      runSessionFollowUpStep(access, [entry.chain.sourcePaneKey], controller.signal).catch(
        (error: unknown) => error
      )
    )
  })
  return { runSessionChainNow, stopSessionChainRun }
})

const registry = await import('@/lib/session-chain-registry')
const runner = await import('@/lib/session-chain-runner')
const commands = await import('./session-follow-up-commands')

const report = exact('report.md', 'final report')
const source = {
  rowKey: 'row',
  worktreeId: 'folder:f1',
  hostId: 'local' as const,
  paneKey: 'tab-1:leaf-1',
  label: 'Draft'
}

function untilAborted<T>(signal: AbortSignal | undefined, value: T): Promise<T> {
  return new Promise((resolve) => signal?.addEventListener('abort', () => resolve(value)))
}

function draft(extra: Partial<SessionFollowUpDraft> = {}): SessionFollowUpDraft {
  return {
    taskId: 'btk_abcd1234',
    taskTitle: 'Webinar intro',
    recipients: [{ employeeId: 'emp_iris', name: 'Iris' }],
    action: 'review',
    deliverables: { kind: 'files', paths: ['/w/report.md'] },
    includeSummary: false,
    note: 'Please review',
    ...extra
  }
}

function rule(extra: Partial<SessionFollowUpRule> = {}): SessionFollowUpRule {
  return {
    revision: 1,
    taskId: 'btk_abcd1234',
    taskTitle: 'Webinar intro',
    sessionLabel: 'Draft',
    recipients: [
      { employeeId: 'emp_iris', name: 'Iris', operationId: 'fu_iris_key', delivery: 'pending' }
    ],
    action: 'review',
    deliverables: { kind: 'files', paths: ['/w/report.md'] },
    includeSummary: false,
    note: 'Please review',
    savedAt: 1,
    ...extra
  }
}

function seed(handoff: SessionFollowUpRule, extra: Partial<SessionChain> = {}): SessionChain {
  const chain: SessionChain = {
    id: 'chn_seeded',
    workspacePath: '/w',
    worktreeId: 'folder:f1',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: 'row',
    auto: true,
    steps: [{ kind: 'handoff', id: 'step_h', status: 'queued', handoff }],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    ...extra
  }
  registry.setSessionChainEntry(chain)
  registry.publishSessionChains()
  return chain
}

function handoffOf(chain: SessionChain): SessionFollowUpRule {
  return (chain.steps[0] as SessionChainHandoffStep).handoff
}

const upserted = (): SessionChain[] =>
  mocks.upsert.mock.calls.map(([, chain]) => chain as SessionChain)
const current = (id: string): SessionFollowUpRule => handoffOf(registry.getSessionChain(id)!)

describe('saved follow-up commands', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    registry.clearSessionChainEntries()
    registry.publishSessionChains()
    mocks.runs.length = 0
    mocks.upsert.mockImplementation(async (_target: unknown, chain: SessionChain) => chain)
    mocks.remove.mockResolvedValue(undefined)
    mocks.waitForStop.mockResolvedValue({ source: { handle: 'term_1' }, exited: false })
    mocks.waitForExit.mockImplementation((_handle: string, _ms: number, signal?: AbortSignal) =>
      untilAborted(signal, { status: 'running', exitCode: null })
    )
    mocks.working.mockImplementation((_pane: string, signal: AbortSignal) =>
      untilAborted(signal, false)
    )
    mocks.host.exists.mockResolvedValue(true)
    mocks.host.size.mockResolvedValue(report.size)
    mocks.host.readExact.mockResolvedValue(report)
    mocks.hub.isRejected.mockReturnValue(false)
    mocks.hub.upload.mockImplementation(async (_task: string, file: ExactHandoffFile) => ({
      path: `handoffs/${file.name}`,
      sha256: file.sha256
    }))
    mocks.hub.send.mockImplementation(async (input: HandoffSend) => ({
      thread_id: `hth_${input.recipient.slice(4)}`
    }))
  })

  afterEach(() => {
    registry.clearSessionChainEntries()
  })

  it('persists a new rule before its run starts and applies the limits there', async () => {
    const chain = await commands.saveSessionFollowUp(
      source,
      draft({
        taskTitle: 'T'.repeat(600),
        recipients: [{ employeeId: 'emp_iris', name: 'N'.repeat(300) }]
      })
    )
    expect(mocks.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runner.runSessionChainNow).mock.invocationCallOrder[0]!
    )
    const saved = handoffOf(upserted()[0]!)
    expect(saved).toMatchObject({ revision: 1, taskId: 'btk_abcd1234' })
    expect(saved.taskTitle).toHaveLength(500)
    expect(saved.recipients[0]?.name).toHaveLength(200)
    expect(saved.recipients[0]?.operationId).toMatch(/^fu_[0-9a-f]{32}$/)
    // Why: the persisted record must load back; normalization is never the first limit check.
    expect(normalizeSessionChains([upserted()[0]])).toHaveLength(1)
    expect(registry.getSessionChain(chain.id)).not.toBeNull()
  })

  it('refuses more than 20 people, or none, with their own messages', async () => {
    const many = Array.from({ length: 21 }, (_, index) => ({
      employeeId: `emp_p${index}`,
      name: `Person ${index}`
    }))
    await expect(commands.saveSessionFollowUp(source, draft({ recipients: many }))).rejects.toThrow(
      'One next step goes to at most 20 people.'
    )
    await expect(commands.saveSessionFollowUp(source, draft({ recipients: [] }))).rejects.toThrow(
      'Choose at least one person.'
    )
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('edits to a new revision, and the run it stopped never writes the old one back', async () => {
    let found: ((value: boolean) => void) | undefined
    mocks.host.exists.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          found = resolve
        })
    )
    const first = await commands.saveSessionFollowUp(source, draft())
    await vi.waitFor(() => expect(mocks.host.exists).toHaveBeenCalledTimes(1))

    let written: (() => void) | undefined
    mocks.upsert.mockImplementationOnce(
      (_target: unknown, chain: SessionChain) =>
        new Promise((resolve) => {
          written = () => resolve(chain)
        })
    )
    const editing = commands.saveSessionFollowUp(
      source,
      draft({ recipients: [{ employeeId: 'emp_gamma', name: 'Gamma' }] })
    )
    // The stopped run finishes its file check while the edit is still being written.
    found?.(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    written?.()
    const edited = await editing
    await vi.waitFor(() => expect(current(first.id).readyAt).toBeDefined())

    expect(edited.id).toBe(first.id)
    const revisions = upserted().map((chain) => handoffOf(chain).revision)
    expect(revisions.slice(0, 2)).toEqual([1, 2])
    expect(revisions.slice(1).every((revision) => revision === 2)).toBe(true)
    expect(current(first.id)).toMatchObject({
      revision: 2,
      recipients: [{ employeeId: 'emp_gamma' }]
    })
    await expect(mocks.runs[0]).resolves.toMatchObject({ name: 'AbortError' })
  })

  it('restores the record it replaced when the write fails', async () => {
    const saved = await commands.saveSessionFollowUp(source, draft())
    await vi.waitFor(() => expect(current(saved.id).readyAt).toBeDefined())
    mocks.upsert.mockRejectedValueOnce(new Error('disk full'))
    await expect(
      commands.saveSessionFollowUp(source, draft({ note: 'Changed note' }))
    ).rejects.toThrow('disk full')
    expect(current(saved.id)).toMatchObject({ revision: 1, note: 'Please review' })
    expect(runner.runSessionChainNow).toHaveBeenCalledTimes(2)
    expect(runner.runSessionChainNow).toHaveBeenLastCalledWith(saved.id)
  })

  it('refuses to edit a rule once its capture began', async () => {
    seed(rule({ capturedAt: 5, files: [] }), { state: 'failed' })
    await expect(commands.saveSessionFollowUp(source, draft())).rejects.toThrow(
      'Delivery already started. Retry or cancel it instead of editing.'
    )
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('sends only after Send now confirms the ready run is finished', async () => {
    const saved = await commands.saveSessionFollowUp(source, draft())
    await vi.waitFor(() => expect(current(saved.id).readyAt).toBeDefined())
    expect(mocks.hub.send).not.toHaveBeenCalled()

    await commands.confirmSessionFollowUpFinished(saved.id)
    await vi.waitFor(() => expect(registry.getSessionChain(saved.id)?.state).toBe('done'))
    expect(runner.stopSessionChainRun).toHaveBeenCalledWith(saved.id)
    expect(mocks.hub.send).toHaveBeenCalledTimes(1)
    expect(current(saved.id)).toMatchObject({
      confirmedAt: expect.any(Number),
      recipients: [{ delivery: 'sent', threadId: 'hth_iris' }]
    })
  })

  it('refuses Send now once the session started another turn', async () => {
    const chain = seed(rule())
    await expect(commands.confirmSessionFollowUpFinished(chain.id)).rejects.toThrow(
      'The session is working again, so this waits for its next stop.'
    )
  })

  it('cancel stops the run and persists the cancel', async () => {
    const saved = await commands.saveSessionFollowUp(source, draft())
    await commands.cancelSessionFollowUp(saved.id)
    expect(runner.stopSessionChainRun).toHaveBeenCalledWith(saved.id)
    expect(registry.getSessionChain(saved.id)?.state).toBe('cancelled')
    expect(upserted().at(-1)?.state).toBe('cancelled')
    await expect(mocks.runs[0]).resolves.toMatchObject({ name: 'AbortError' })
    expect(mocks.hub.send).not.toHaveBeenCalled()
  })

  it('retry keeps sent people, replays an unconfirmed key and re-keys a refused person', async () => {
    const pin = {
      sourcePath: '/w/report.md',
      name: 'report.md',
      sha256: report.sha256,
      size: report.size,
      taskPath: 'handoffs/report.md'
    }
    const chain = seed(
      rule({
        capturedAt: 5,
        files: [pin],
        recipients: [
          {
            employeeId: 'emp_iris',
            name: 'Iris',
            operationId: 'fu_iris_key',
            delivery: 'sent',
            threadId: 'hth_iris'
          },
          {
            employeeId: 'emp_gamma',
            name: 'Gamma',
            operationId: 'fu_gamma_key',
            delivery: 'sending'
          },
          {
            employeeId: 'emp_eve',
            name: 'Eve',
            operationId: 'fu_eve_key',
            delivery: 'failed',
            error: 'HTTP 403'
          }
        ],
        exception: { code: 'rejected', subject: 'Eve', detail: 'HTTP 403', at: 9 }
      }),
      { state: 'failed' }
    )
    await commands.retrySessionFollowUp(chain.id)
    await vi.waitFor(() => expect(registry.getSessionChain(chain.id)?.state).toBe('done'))

    expect(handoffOf(upserted()[0]!)).not.toHaveProperty('exception')
    const keys = mocks.hub.send.mock.calls.map(([input]) => (input as HandoffSend).operationId)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe('fu_gamma_key')
    expect(keys[1]).toMatch(/^fu_[0-9a-f]{32}$/)
    expect(mocks.hub.upload).not.toHaveBeenCalled()
  })

  it('retry after the captured files changed takes them again instead of failing the same way', async () => {
    const stale = { sourcePath: '/w/report.md', name: 'report.md', sha256: 'a'.repeat(64), size: 3 }
    const chain = seed(
      rule({
        confirmedAt: 4,
        capturedAt: 5,
        files: [stale],
        exception: { code: 'files-changed', subject: 'report.md', detail: '', at: 9 }
      }),
      { state: 'failed' }
    )
    await commands.retrySessionFollowUp(chain.id)
    expect(handoffOf(upserted()[0]!)).not.toHaveProperty('capturedAt')
    expect(handoffOf(upserted()[0]!)).not.toHaveProperty('files')
    await vi.waitFor(() => expect(registry.getSessionChain(chain.id)?.state).toBe('done'))
    expect(mocks.hub.upload).toHaveBeenCalledWith('btk_abcd1234', report)
    const firstSend = mocks.hub.send.mock.calls[0]?.[0] as HandoffSend | undefined
    expect(firstSend?.fileVersions).toEqual([{ path: 'handoffs/report.md', sha256: report.sha256 }])
  })

  it('dismiss forgets the record here and on the host', async () => {
    const chain = seed(rule(), { state: 'cancelled' })
    await commands.dismissSessionFollowUp(chain.id)
    expect(registry.getSessionChain(chain.id)).toBeNull()
    expect(mocks.remove).toHaveBeenCalledWith({ kind: 'local' }, chain.id)
  })
})
