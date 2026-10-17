import { describe, expect, it, vi } from 'vitest'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'
import { makePaneKey } from '../../shared/stable-pane-id'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../runtime/remote-runtime-terminal-create-identity'
import { transferArchiveTarget } from './session-transfer-archive'
import { transferAcknowledgementInstruction } from './session-transfer-acknowledgement'
import { FREEFORM_NOT_AN_APPROVAL } from './session-manage-freeform'
import type { RpcContext } from '../runtime/rpc/core'
import { waitForAskReply } from './session-manage-ask-wait'
import type { SessionDeliveryDeps } from './session-manage-deliver'
import { transferBrief } from './session-manage-transfer'
import { runtimeTransferDeps } from './session-manage-transfer-runtime'
import { pushQuestion } from './session-transfer-host'
import { transferSession } from './session-manage-transfer-fixtures'
import {
  prepareSessionAction,
  recordSessionAction
} from '../runtime/rpc/methods/session-manage-support'

vi.mock('../runtime/rpc/methods/session-manage-support', () => ({
  prepareSessionAction: vi.fn(),
  recordSessionAction: vi.fn(async () => undefined)
}))
// The real core delivery (`queueQuestion`, `continueSession`) runs over this queue.
const delivery = vi.hoisted(() => ({ current: null as SessionDeliveryDeps | null }))

vi.mock('./session-manage-ask-wait', () => ({
  waitForAskReply: vi.fn(() => new Promise(() => {})),
  turnAnswersQuestion: vi.fn()
}))
vi.mock('./session-manage-runtime-actions', () => ({
  runtimeDeliveryDeps: vi.fn(() => delivery.current),
  runtimeAskWaitDeps: vi.fn(),
  showSessionManageNotice: vi.fn()
}))

/** Two pending proposals: a bare approval here would be refused as ambiguous. */
function twoProposals(): NextStepSuggestionSet {
  return {
    id: 'set-1',
    status: 'pending',
    suggestions: ['Deploy to production', 'Write tests'].map((title, index) => ({
      id: `s${index + 1}`,
      title,
      prompt: title,
      risk: 'safe',
      kind: 'other',
      offered: true as const
    }))
  } as NextStepSuggestionSet
}

function queue(set: NextStepSuggestionSet | null = null) {
  const latest = {
    known: true,
    turnKey: 'turn-1',
    text: 'The parser fix is ready.',
    complete: true,
    proposal: set ? JSON.stringify(set.suggestions) : null,
    empty: false
  }
  const deps = {
    enqueue: vi.fn(),
    admission: vi.fn(() => null),
    bind: vi.fn(() => vi.fn()),
    readLatestTurn: vi.fn(async () => latest),
    snapshotLatestTurn: vi.fn(() => latest),
    hasUnresolvedDraft: vi.fn(() => false),
    decideRelayed: vi.fn(),
    stopKeepGoing: vi.fn(() => false),
    readOwnSteps: vi.fn(async () => ({ set, steps: set?.suggestions ?? [] })),
    newId: () => '3f9a1c2e-0000-4000-8000-000000000000'
  } satisfies SessionDeliveryDeps
  delivery.current = deps
  return deps
}

function fixture() {
  let createdPane = ''
  const createTerminal = vi.fn(
    async (
      selector: string,
      options: { preAllocatedHandle: string; tabId: string; leafId: string }
    ) => {
      createdPane = makePaneKey(options.tabId, options.leafId)
      return {
        handle: options.preAllocatedHandle,
        paneKey: createdPane,
        tabId: options.tabId,
        ptyId: 'pty-new',
        worktreeId: selector.slice(3)
      }
    }
  )
  const dedupeTerminalCreate = vi.fn(
    async (
      client: string,
      selector: string,
      operation: string,
      _reconcile: boolean,
      run: (selector: string, handle: string) => Promise<unknown>
    ) =>
      run(selector, deriveRemoteRuntimeTerminalCreateHandle(client, selector.slice(3), operation))
  )
  const requestSessionFolders = vi.fn(async (request: SessionFolderRelayRequest) => ({
    summary: 'done',
    ...(request.kind === 'archiveSessions'
      ? { archived: request.targets, operationId: request.operationId }
      : {}),
    ...(request.kind === 'fileTransferredSession'
      ? { sessionKey: request.target.viewKey, folderId: request.folderId, at: Date.now() }
      : {})
  }))
  const context = {
    runtime: {
      createTerminal,
      dedupeTerminalCreate,
      requestSessionFolders,
      getTerminalPaneKey: () => createdPane
    }
  } as unknown as RpcContext
  const actor = { kind: 'pane' as const, paneKey: 'actor', title: 'Coordinator' }
  return {
    createTerminal,
    requestSessionFolders,
    actor,
    deps: runtimeTransferDeps(context, actor, {
      reason: 'combine work',
      request: 'Please carry it over'
    })
  }
}

describe('session transfer runtime adapter', () => {
  it('asks through the core: bound to the agent process, answered by its own question id', async () => {
    const d = queue()
    const { deps } = fixture()
    const source = transferSession('source')
    const pending = await deps.ask(source, 'Write a handoff.')
    expect(d.enqueue).toHaveBeenCalledExactlyOnceWith(source.source, {
      id: 'session-ask:3f9a1c2e-0000-4000-8000-000000000000',
      text: expect.stringContaining(`${FREEFORM_NOT_AN_APPROVAL}\nWrite a handoff.`),
      requestedBy: { action: 'ask', actor: 'actor' }
    })
    expect(d.bind).toHaveBeenCalledWith(
      source.source,
      'session-ask:3f9a1c2e-0000-4000-8000-000000000000',
      {
        receiver: source.agentProcess,
        conversationGuard: expect.any(Function),
        conversationStill: expect.any(Function)
      }
    )
    expect(vi.mocked(waitForAskReply).mock.lastCall?.[1]).toMatchObject({
      marker: expect.stringContaining('q-3f9a1c2e'),
      sentText: pending.sent
    })
  })

  it('delivers the brief through continue, tagged with its own id, never read as an approval', async () => {
    const d = queue()
    const { deps } = fixture()
    const target = transferSession('target')
    const sources = [transferSession('yes'), transferSession('2')]
    const brief = transferBrief('consolidate', sources, ['ok', 'go ahead'])
    const pending = await deps.deliver(target, brief)
    const marker = '[Brief b-3f9a1c2e-0000-4000-8000-000000000000] '
    expect(pending.acknowledgement).toBe('Accepted transfer 3f9a1c2e-0000-4000-8000-000000000000')
    expect(pending.sent).toBe(
      `${marker}[from Coordinator] ${FREEFORM_NOT_AN_APPROVAL}\n${brief}\n\n${transferAcknowledgementInstruction(pending.acknowledgement!)}`
    )
    expect(d.enqueue).toHaveBeenCalledExactlyOnceWith(target.source, {
      id: expect.stringMatching(/^session-manage:/),
      text: pending.sent,
      requestedBy: { action: 'continue', actor: 'actor' }
    })
    expect(d.bind).toHaveBeenCalledWith(target.source, expect.stringMatching(/^session-manage:/), {
      receiver: target.agentProcess,
      conversationGuard: expect.any(Function),
      conversationStill: expect.any(Function)
    })
    expect(vi.mocked(waitForAskReply).mock.lastCall?.[1]).toMatchObject({
      marker,
      requireCompleteReply: true,
      sentText: pending.sent
    })
  })

  it('refuses a brief when the target has its own open proposals', async () => {
    const d = queue(twoProposals())
    const { deps } = fixture()
    await expect(
      deps.deliver(transferSession('target'), 'Investigate the parser.')
    ).rejects.toThrow('proposes next steps')
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it('refuses to deliver to a target whose agent process is not proven', async () => {
    const d = queue()
    const { deps } = fixture()
    const target = { ...transferSession('target'), agentProcess: null }
    await expect(deps.deliver(target, 'brief')).rejects.toThrow(/could not be proven/)
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it('waits for a new target until its own agent process holds the pane', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = fixture()
      const target = transferSession('new-pane')
      const unproven = {
        ...target,
        actor: { kind: 'cli' as const },
        rows: [target.row],
        agentProcess: null
      }
      const proven = { ...unproven, agentProcess: target.agentProcess ?? null }
      vi.mocked(prepareSessionAction).mockResolvedValueOnce(unproven).mockResolvedValueOnce(proven)
      const refreshed = deps.refresh(target, true)
      await vi.advanceTimersByTimeAsync(300)
      expect(await refreshed).toBe(proven)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['repo::/ssh/project', 'folder:workspace'])(
    'uses the source workspace selector and configured agent launcher for %s',
    async (worktreeId) => {
      const { deps, createTerminal } = fixture()
      const source = transferSession('source', { worktreeId, agent: 'codex' })
      const target = await deps.create(source, 'source (continued)')
      expect(createTerminal).toHaveBeenCalledWith(
        `id:${worktreeId}`,
        expect.objectContaining({
          startupAgent: 'codex',
          title: 'source (continued)',
          isNewSession: true,
          activate: false,
          focus: false
        })
      )
      expect(target.entry).toMatchObject({
        paneKey: expect.any(String),
        tabId: expect.any(String),
        terminal: expect.stringMatching(/^term_/),
        state: 'unknown',
        verdict: 'unverifiable'
      })
      expect(target.source).toBeNull()
      deps.dispose?.()
    }
  )

  it.each([
    { folderId: 'folder-1', saved: true, destination: 'folder', folder: 'folder-1' },
    { folderId: null, saved: true, destination: 'saved' },
    { folderId: null, saved: false, destination: 'unfile' }
  ])('files the new conversation in the source placement $destination', async (placement) => {
    const { deps, requestSessionFolders } = fixture()
    const source = transferSession('source')
    source.row.folderId = placement.folderId
    source.row.saved = placement.saved
    await deps.file(transferSession('new-pane'), source)
    expect(requestSessionFolders).toHaveBeenCalledWith({
      kind: 'fileTransferredSession',
      operationId: expect.any(String),
      expiresAt: expect.any(Number),
      target: transferArchiveTarget(transferSession('new-pane')),
      folderId: placement.folderId ?? (placement.saved ? 'saved-sessions' : null)
    })
  })

  it('archives all source identities in a single renderer request', async () => {
    const { deps, requestSessionFolders } = fixture()
    await deps.archive(
      [transferSession('a'), transferSession('b')],
      'consolidated into Target',
      () => true,
      transferSession('target')
    )
    expect(requestSessionFolders).toHaveBeenCalledExactlyOnceWith({
      kind: 'archiveSessions',
      operationId: expect.any(String),
      commitToken: expect.any(String),
      acknowledgedTarget: transferArchiveTarget(transferSession('target')),
      targets: [
        transferArchiveTarget(transferSession('a')),
        transferArchiveTarget(transferSession('b'))
      ],
      reason: 'consolidated into Target',
      expiresAt: expect.any(Number)
    })
  })

  it('uses a fresh observation rather than the snapshot before the source answer', async () => {
    const { deps } = fixture()
    const source = transferSession('source')
    const fresh = {
      ...source,
      actor: { kind: 'cli' as const },
      rows: [source.row],
      agentProcess: source.agentProcess ?? null,
      entry: { ...source.entry, state: 'working' as const }
    }
    vi.mocked(prepareSessionAction).mockResolvedValueOnce(fresh)
    expect(await deps.refresh(source)).toBe(fresh)
  })

  it('writes the actor and requested provenance, preserving the specific archive reason', async () => {
    const { deps, actor } = fixture()
    await deps.audit({
      actor,
      action: 'session.archive',
      target: transferSession('a'),
      summary: 'Archived source',
      reason: 'handed off to Target',
      after: { archived: true }
    })
    expect(recordSessionAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actor,
        action: 'session.archive',
        provenance: { reason: 'handed off to Target', request: 'Please carry it over' },
        after: { archived: true }
      })
    )
  })

  it('asks a source to push through the same ask, turning its Keep going off first', async () => {
    const d = queue()
    d.stopKeepGoing.mockReturnValue(true)
    const { deps } = fixture()
    const source = transferSession('source')
    const question = pushQuestion({
      kind: 'git',
      path: '/w',
      branch: 'feat/parser',
      head: 'abc123',
      upstream: 'none',
      uncommitted: 1
    })
    const pending = await deps.ask(source, question)
    expect(d.stopKeepGoing).toHaveBeenCalledWith(source.source, expect.any(String))
    expect(pending.sent).toContain('push branch feat/parser to its remote')
  })

  it('refuses to ask a source to push a shared branch: that is a hard stop', async () => {
    const d = queue()
    const { deps } = fixture()
    const question = pushQuestion({
      kind: 'git',
      path: '/w',
      branch: 'main',
      head: 'abc123',
      upstream: { name: 'origin/main', ahead: 1 },
      uncommitted: 0
    })
    await expect(deps.ask(transferSession('source'), question)).rejects.toThrow(
      'hard stop: shared-branch'
    )
    expect(d.enqueue).not.toHaveBeenCalled()
  })
})
