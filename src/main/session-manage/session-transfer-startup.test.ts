import { describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { RpcContext } from '../runtime/rpc/core'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../runtime/remote-runtime-terminal-create-identity'
import { revokeWriteFencesWhere } from '../runtime/conversation-write-fence'
import { prepareSessionAction } from '../runtime/rpc/methods/session-manage-support'
import { runtimeTransferDeps } from './session-manage-transfer-runtime'
import { transferSession } from './session-manage-transfer-fixtures'
import { assertSameTransferSession } from './session-transfer-identity'

const hooks = vi.hoisted(() => ({
  listener: null as ((event: AgentHookEventPayload) => void) | null
}))

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    subscribeEnrichedStatus: (listener: (event: AgentHookEventPayload) => void) => {
      hooks.listener = listener
      return () => {
        hooks.listener = null
      }
    }
  }
}))
vi.mock('../runtime/rpc/methods/session-manage-support', () => ({
  prepareSessionAction: vi.fn(),
  recordSessionAction: vi.fn(async () => undefined)
}))
vi.mock('./session-manage-runtime-actions', () => ({
  runtimeDeliveryDeps: vi.fn(() => ({})),
  runtimeAskWaitDeps: vi.fn(),
  showSessionManageNotice: vi.fn()
}))

async function fixture() {
  let paneKey = ''
  let handle = ''
  const runtime = {
    createTerminal: vi.fn(async (_selector, options) => {
      paneKey = makePaneKey(options.tabId, options.leafId)
      handle = options.preAllocatedHandle
      return { handle, ptyId: 'new-pty', worktreeId: 'repo::/w' }
    }),
    dedupeTerminalCreate: vi.fn(async (client, selector, operation, _reconcile, run) =>
      run(selector, deriveRemoteRuntimeTerminalCreateHandle(client, selector.slice(3), operation))
    ),
    getTerminalPaneKey: () => paneKey,
    resolveTerminalPane: () => ({ handle, ptyId: 'new-pty', connected: true }),
    requestSessionFolders: vi.fn(async (request) => ({
      sessionKey: request.target.viewKey,
      folderId: request.folderId
    }))
  }
  const deps = runtimeTransferDeps({ runtime } as unknown as RpcContext, { kind: 'cli' }, {})
  const created = await deps.create(transferSession('source', { worktreeId: 'repo::/w' }), 'target')
  const observed = transferSession(paneKey, {
    terminal: handle,
    tabId: created.entry.tabId,
    worktreeId: created.entry.worktreeId
  })
  observed.row.tabId = created.entry.tabId
  observed.row.viewKey = 'temporary-pane-key'
  observed.agentProcess = { ...observed.agentProcess!, ptyId: 'new-pty' }
  const prepared = () => ({
    ...observed,
    agentProcess: observed.agentProcess ?? null,
    rows: [observed.row],
    actor: { kind: 'cli' as const }
  })
  vi.mocked(prepareSessionAction).mockImplementation(async () => prepared())
  const publishIdentity = () => {
    observed.row = {
      ...observed.row,
      providerSessionId: 'provider-session',
      viewKey: 'provider-key'
    }
  }
  const start = () =>
    hooks.listener?.({
      paneKey,
      source: 'claude',
      connectionId: null,
      hookEventName: 'SessionStart',
      sessionStartSource: 'startup',
      payload: { state: 'done' }
    } as AgentHookEventPayload)
  return { deps, created, observed, prepared, publishIdentity, start, runtime }
}

describe('fresh transfer target readiness', () => {
  it('waits for provider identity before filing, so the next observation keeps the same identity', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    try {
      f.start()
      let ready = false
      const waiting = f.deps.refresh(f.created, true).then((target) => {
        ready = true
        return target
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(ready).toBe(false)
      expect(f.runtime.requestSessionFolders).not.toHaveBeenCalled()
      f.publishIdentity()
      await vi.advanceTimersByTimeAsync(250)
      const target = await waiting
      await f.deps.file(target, transferSession('source'))
      expect(f.runtime.requestSessionFolders).toHaveBeenCalledWith(
        expect.objectContaining({ target: expect.objectContaining({ viewKey: 'provider-key' }) })
      )
      const fresh = await f.deps.refresh(target)
      expect(() => assertSameTransferSession(target, fresh)).not.toThrow()
      expect(f.runtime.createTerminal).toHaveBeenCalledTimes(1)
    } finally {
      f.deps.dispose?.()
      vi.useRealTimers()
    }
  })

  it('requires the original fresh-start proof even when provider identity is already visible', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    try {
      f.publishIdentity()
      let ready = false
      const waiting = f.deps.refresh(f.created, true).then((target) => {
        ready = true
        return target
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(ready).toBe(false)
      f.start()
      await vi.advanceTimersByTimeAsync(250)
      expect(await waiting).toMatchObject({ row: { providerSessionId: 'provider-session' } })
    } finally {
      f.deps.dispose?.()
      vi.useRealTimers()
    }
  })

  it('times out without filing or sending when another writer touched the new target', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    try {
      f.publishIdentity()
      f.start()
      revokeWriteFencesWhere((source) => source.paneKey === f.created.entry.paneKey, 'input')
      const waiting = f.deps.refresh(f.created, true)
      const rejected = expect(waiting).rejects.toThrow('fresh provider conversation')
      await Promise.all([rejected, vi.advanceTimersByTimeAsync(60_000)])
      expect(f.runtime.requestSessionFolders).not.toHaveBeenCalled()
      expect(f.runtime.createTerminal).toHaveBeenCalledTimes(1)
    } finally {
      f.deps.dispose?.()
      vi.useRealTimers()
    }
  })
})
