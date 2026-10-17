import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, makeRepo, testState } from '../persistence-test-harness'
import { createAutomationRunWriter } from './automation-run-writer'
import { launchHeadlessAutomationTerminal } from './headless-dispatch'
import { runHeadlessAutomationDispatch } from './headless-dispatch-runner'
import {
  assertHeadlessAutomationWorktreeStartup,
  assertHeadlessAutomationWaitSettled,
  prepareHeadlessAutomationLaunch
} from './headless-dispatch-setup'
import type { AutomationDispatchResult } from '../../shared/automations-types'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'

let store: ReturnType<typeof createStore>
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'headless-launch-recovery-'))
  store = createStore()
})
afterEach(async () => {
  await store.flushAsync()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

function fixture() {
  const repo = makeRepo()
  store.addRepo(repo)
  const workspaceId = `${repo.id}::${repo.path}`
  const automation = store.createAutomation({
    name: 'Routine',
    prompt: 'Check the current task',
    agentId: 'claude',
    projectId: repo.id,
    workspaceMode: 'existing',
    workspaceId,
    reuseSession: true,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: Date.now()
  })
  const run = store.createAutomationRun(automation, Date.now(), 'manual')
  const terminal = {
    workspaceId,
    terminalSessionId: 'tab-worker',
    terminalPaneKey: 'tab-worker:11111111-1111-4111-8111-111111111111',
    terminalPtyId: 'pty-worker',
    ownsTerminal: true
  }
  const watch = vi.fn()
  const persist = vi.fn(async (result: AutomationDispatchResult) =>
    store.updateAutomationRun(result)
  )
  const dispatch = (dispatcher: HeadlessAutomationDispatcher) =>
    runHeadlessAutomationDispatch({
      automation,
      run,
      target: { ok: true, repo, cwd: repo.path },
      dispatcher,
      runs: createAutomationRunWriter(store, null),
      runPrecheck: async () => null,
      markDispatchResult: persist,
      watchRun: watch,
      assertDispatchAllowed: () => {}
    })
  const readRun = () =>
    store.listAutomationRuns(automation.id).find((entry) => entry.id === run.id)!
  return { automation, run, terminal, watch, persist, dispatch, readRun }
}

describe('headless routine launch recovery', () => {
  it('retains a newly created workspace whose startup process receipt is unknown', async () => {
    const h = fixture()
    const partial = {
      workspaceId: 'new-workspace',
      workspaceDisplayName: 'New worker',
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null,
      ownsTerminal: true
    }
    const result = await h.dispatch(async () => {
      assertHeadlessAutomationWorktreeStartup(
        { startupTerminalOutcome: 'unverifiable', warning: 'registration reply lost' },
        partial
      )
      throw new Error('Expected an unknown startup receipt')
    })
    expect(result).toMatchObject({
      ...partial,
      status: 'dispatched',
      launchOutcome: 'unverifiable',
      error: 'registration reply lost'
    })
    expect(h.readRun()).toMatchObject(result)
    expect(h.watch).toHaveBeenCalledExactlyOnceWith(result)
  })

  it('keeps a prebirth workspace startup refusal an ordinary dispatch failure', async () => {
    const h = fixture()
    const result = await h.dispatch(async () => {
      assertHeadlessAutomationWorktreeStartup({ warning: 'provider unavailable' }, h.terminal)
      throw new Error('provider unavailable')
    })
    expect(result).toMatchObject({ status: 'dispatch_failed', error: 'provider unavailable' })
    expect(result.launchOutcome).not.toBe('unverifiable')
    expect(h.watch).not.toHaveBeenCalled()
  })

  it.each(['codex-trust-workspace', 'agent-approval-prompt'])(
    'holds the known worker waiting at %s and starts its completion watcher',
    async (blockedReason) => {
      const h = fixture()
      await h.dispatch(async () => ({
        ...h.terminal,
        completion: Promise.resolve().then(() => {
          assertHeadlessAutomationWaitSettled(h.terminal, { satisfied: false, blockedReason })
          return { status: 'completed' as const }
        })
      }))
      await vi.waitFor(() => expect(h.watch).toHaveBeenCalledOnce())

      expect(h.readRun()).toMatchObject({
        ...h.terminal,
        status: 'dispatched',
        launchOutcome: 'unverifiable'
      })
      expect(h.readRun().error).toContain('waiting for input')
      expect(h.watch).toHaveBeenCalledWith(h.readRun())
    }
  )

  it('keeps an unsupported blocked result an ordinary final failure', async () => {
    const h = fixture()
    await h.dispatch(async () => ({
      ...h.terminal,
      completion: Promise.resolve().then(() => {
        assertHeadlessAutomationWaitSettled(h.terminal, {
          satisfied: false,
          blockedReason: 'provider-authentication'
        })
        return { status: 'dispatch_failed' as const }
      })
    }))
    await vi.waitFor(() => expect(h.readRun().status).toBe('dispatch_failed'))
    expect(h.readRun().launchOutcome).not.toBe('unverifiable')
    expect(h.watch).not.toHaveBeenCalled()
  })

  it.each(['terminal wait', 'terminal read', 'completion persistence'])(
    'retains and observes the known worker after %s fails',
    async (stage) => {
      const h = fixture()
      let settle!: () => void
      let fail!: (cause: Error) => void
      const completion = new Promise<{ status: 'completed' }>((resolve, reject) => {
        settle = () => resolve({ status: 'completed' })
        fail = reject
      })
      await h.dispatch(async () => ({ ...h.terminal, completion }))
      if (stage === 'completion persistence') {
        h.persist.mockRejectedValueOnce(new Error('completion save failed'))
        settle()
      } else {
        fail(new Error(`${stage} connection lost`))
      }
      await vi.waitFor(() => expect(h.watch).toHaveBeenCalledOnce())

      expect(h.readRun()).toMatchObject({
        ...h.terminal,
        status: 'dispatched',
        launchOutcome: 'unverifiable'
      })
      expect(h.watch).toHaveBeenCalledWith(h.readRun())
      expect(h.readRun().error).toContain(
        stage === 'completion persistence' ? 'save failed' : 'connection lost'
      )
    }
  )

  it.each(['workspace display', 'output binding'])(
    'retains the launch binding after downstream %s setup fails',
    async (stage) => {
      const h = fixture()
      const failure = new Error(`${stage} unavailable`)
      const result = await h.dispatch(async () =>
        prepareHeadlessAutomationLaunch(h.terminal, () => {
          throw failure
        })
      )

      expect(result).toMatchObject({
        ...h.terminal,
        status: 'dispatched',
        launchOutcome: 'unverifiable',
        error: failure.message
      })
      expect(h.watch).toHaveBeenCalledExactlyOnceWith(result)
    }
  )

  it.each(['paste', 'Enter'])(
    'keeps the original reused terminal observable after its %s reply is lost',
    async (stage) => {
      const h = fixture()
      const prior = store.createAutomationRun(h.automation, Date.now() - 1_000)
      store.updateAutomationRun({
        runId: prior.id,
        status: 'completed',
        providerSession: { providerSessionAgent: 'claude', providerSessionId: 'recorded-thread' }
      })
      const send = vi.fn().mockRejectedValue(new Error(`${stage} reply lost`))
      if (stage === 'Enter') {
        send.mockResolvedValueOnce({ accepted: true })
      }
      const runtime = {
        launchAgentTerminal: vi.fn(),
        getTerminalHandleForPaneKey: () => 'handle-worker',
        showTerminal: vi.fn().mockResolvedValue({
          handle: 'handle-worker',
          connected: true,
          worktreeId: h.terminal.workspaceId,
          tabId: h.terminal.terminalSessionId,
          ptyId: h.terminal.terminalPtyId
        }),
        sendAutomationInput: send
      }
      const result = await h.dispatch(async () => {
        await launchHeadlessAutomationTerminal({
          runtime,
          automation: h.automation,
          run: h.run,
          runs: store.listAutomationRuns(h.automation.id),
          localWorkspace: true,
          openThreadIds: new Set(['recorded-thread']),
          idleThreadPaneKeys: new Map([['recorded-thread', h.terminal.terminalPaneKey]]),
          launch: { agent: 'claude', prompt: h.automation.prompt }
        })
        throw new Error('Expected an unconfirmed input reply')
      })

      expect(result).toMatchObject({
        ...h.terminal,
        ownsTerminal: false,
        status: 'dispatched',
        launchOutcome: 'unverifiable'
      })
      expect(h.watch).toHaveBeenCalledExactlyOnceWith(result)
      expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledTimes(stage === 'paste' ? 1 : 2)
    }
  )
})
