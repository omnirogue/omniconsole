import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStore, makeRepo, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/omni-runtime'
import { prepareClaudeResumeLaunch } from '../claude/claude-resume-launch'
import { launchHeadlessAutomationTerminal } from './headless-dispatch'
import { runHeadlessAutomationDispatch } from './headless-dispatch-runner'
import { createAutomationRunWriter } from './automation-run-writer'
import { AutomationService } from './service'
import { dispatchScheduledOccurrence } from './routine-run-exclusivity'
import type { AutomationRun } from '../../shared/automations-types'
import {
  AGENT_PROMPT_SUBMIT,
  buildAgentPromptPasteBytes
} from '../../shared/agent-prompt-injection'

let store: ReturnType<typeof createStore>
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'headless-reuse-'))
  store = createStore()
})
afterEach(async () => {
  await store.flushAsync()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

function fixture(reuseSession = true, agentId: 'claude' | 'codex' = 'claude') {
  const repo = makeRepo()
  store.addRepo(repo)
  const workspaceId = `${repo.id}::${repo.path}`
  const automation = store.createAutomation({
    name: 'Check',
    prompt: 'Check',
    agentId,
    projectId: repo.id,
    workspaceMode: 'existing',
    workspaceId,
    reuseSession,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: Date.now()
  })
  const prior = store.createAutomationRun(automation, Date.now() - 1000)
  store.updateAutomationRun({
    runId: prior.id,
    status: 'completed',
    workspaceId,
    providerSession: { providerSessionAgent: agentId, providerSessionId: 'recorded-thread' }
  })
  const runtime = new OrcaRuntimeService(store)
  Object.assign(runtime, {
    resolveWorktreeSelector: async () => ({ id: workspaceId, repoId: repo.id, path: repo.path }),
    buildStartupForAgent: async () => ({
      agent: 'claude',
      startup: { command: 'claude', env: {} }
    }),
    markWorkspaceTrustedForAgent: async () => {}
  })
  const conversations = new Set<string>()
  const create = vi
    .spyOn(runtime, 'createTerminal')
    .mockImplementation(async (_workspace, opts) => {
      opts?.onResumePrepared?.(opts.resumeProviderSession ?? null)
      conversations.add(opts?.resumeProviderSession?.id ?? randomUUID())
      return {
        handle: 'handle',
        worktreeId: workspaceId,
        title: 'Check',
        tabId: 'tab',
        paneKey: 'tab:leaf',
        ptyId: 'pty'
      }
    })
  const launch = (
    run: AutomationRun,
    localWorkspace = true,
    openThreadIds?: ReadonlySet<string>,
    idleThreadPaneKeys?: ReadonlyMap<string, string>
  ) =>
    launchHeadlessAutomationTerminal({
      runtime,
      automation,
      run,
      runs: store.listAutomationRuns(automation.id),
      localWorkspace,
      openThreadIds,
      idleThreadPaneKeys,
      launch: { agent: automation.agentId, prompt: 'Check', title: run.title }
    })
  const dispatch = (run: AutomationRun) =>
    runHeadlessAutomationDispatch({
      automation: automation,
      run,
      target: { ok: true, repo: repo, cwd: repo.path },
      dispatcher: async ({ run }) => {
        const launched = await launch(run)
        return {
          workspaceId: launched.terminal.worktreeId,
          terminalSessionId: launched.terminal.tabId!,
          terminalPaneKey: launched.terminal.paneKey,
          terminalPtyId: launched.terminal.ptyId,
          ownsTerminal: true,
          resume: launched.resume
        }
      },
      runs: createAutomationRunWriter(store, null),
      runPrecheck: async () => null,
      markDispatchResult: async (result) => store.updateAutomationRun(result),
      watchRun: () => {},
      assertDispatchAllowed: () => {}
    })
  return { automation, prior, repo, workspaceId, runtime, conversations, create, launch, dispatch }
}

it('persists prepared controller resume outcomes across three dispatches', async () => {
  const h = fixture()
  const results: AutomationRun['resume'][] = []
  for (let i = 0; i < 3; i += 1) {
    const run = store.createAutomationRun(h.automation, Date.now() + i)
    const dispatched = await h.dispatch(run)
    results.push(dispatched.resume)
    store.updateAutomationRun({
      runId: run.id,
      status: 'completed',
      providerSession: {
        providerSessionAgent: 'claude',
        providerSessionId: [...h.conversations].at(-1)!
      }
    })
  }
  expect(h.create).toHaveBeenCalledTimes(3)
  expect([...h.conversations]).toEqual(['recorded-thread'])
  expect(results).toEqual(
    Array.from({ length: 3 }, () => ({ requested: 'recorded-thread', outcome: 'resumed' }))
  )
})

it('falls back to exactly one fresh conversation after real missing-transcript preparation and records its reason', async () => {
  const h = fixture()
  store.updateAutomationRun({
    runId: h.prior.id,
    status: 'completed',
    providerSession: {
      providerSessionAgent: 'claude',
      providerSessionId: randomUUID(),
      providerSessionTranscriptPath: join(testState.dir, 'deleted.jsonl')
    }
  })
  let fresh = 0
  h.create.mockImplementation(async (_workspace, opts) => {
    await prepareClaudeResumeLaunch(opts ?? {})
    fresh += 1
    return { handle: 'fresh', worktreeId: h.workspaceId, title: 'Check' }
  })
  const run = store.createAutomationRun(h.automation, Date.now())
  await h.dispatch(run)
  expect(h.create).toHaveBeenCalledTimes(2)
  expect(fresh).toBe(1)
  expect(store.listAutomationRuns().find((row) => row.id === run.id)?.resume).toMatchObject({
    outcome: 'fresh',
    reason: 'Claude resume transcript is missing and no verified fallback is available.'
  })
})

it.each([new Error('resume refused'), 'plain rejection', undefined])(
  'an unclassified resume rejection never starts another conversation: %s',
  async (error) => {
    const h = fixture()
    h.create.mockRejectedValueOnce(error)
    await expect(h.launch(store.createAutomationRun(h.automation, Date.now()))).rejects.toBe(error)
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.conversations.size).toBe(0)
  }
)

it('records a definite pre-spawn refusal as failed without holding the next run', async () => {
  const h = fixture()
  const failure = new Error('workspace launch authority refused')
  h.create.mockRejectedValueOnce(failure)
  const run = store.createAutomationRun(h.automation, Date.now())
  const result = await h.dispatch(run)
  expect(result.status).toBe('dispatch_failed')
  expect(result.launchOutcome).toBeUndefined()
  expect(h.create).toHaveBeenCalledTimes(1)
  expect(h.conversations.size).toBe(0)
  expect(store.createAutomationRun(h.automation, Date.now() + 1).id).not.toBe(run.id)
})

it('retains an ambiguous execution-host reply without starting a fresh worker', async () => {
  const h = fixture()
  h.create.mockRejectedValueOnce(
    Object.assign(new Error('execution host disconnected'), {
      agentSessionOperationOutcome: 'unknown'
    })
  )
  const run = store.createAutomationRun(h.automation, Date.now())
  expect(await h.dispatch(run)).toMatchObject({
    status: 'dispatching',
    launchOutcome: 'unverifiable'
  })
  expect(h.create).toHaveBeenCalledTimes(1)
})

it('does not launch a fresh worker when resumed process creation succeeds but publication fails', async () => {
  const h = fixture()
  const failure = new Error('terminal publication failed')
  h.create.mockImplementationOnce(async (_workspace, opts) => {
    opts?.onResumePrepared?.(opts.resumeProviderSession ?? null)
    h.conversations.add(opts!.resumeProviderSession!.id)
    opts?.onPtySpawnCommitted?.()
    throw failure
  })
  const run = store.createAutomationRun(h.automation, Date.now())
  const result = await h.dispatch(run)
  expect(result).toMatchObject({
    status: 'dispatching',
    launchOutcome: 'unverifiable',
    error: failure.message
  })
  expect(h.create).toHaveBeenCalledTimes(1)
  expect([...h.conversations]).toEqual(['recorded-thread'])
  const dispatch = vi.fn(async () => {
    throw new Error('A second worker must not launch')
  })
  const service = new AutomationService(store, { headlessDispatcher: dispatch })
  expect((await service.runNow(h.automation.id)).id).toBe(run.id)
  const later = await dispatchScheduledOccurrence({
    automation: h.automation,
    scheduledFor: Date.now() + 60_000,
    history: store.listAutomationRuns(h.automation.id),
    runs: createAutomationRunWriter(store, null),
    launchable: true,
    dispatch
  })
  expect(later.status).toBe('skipped_unavailable')
  expect(dispatch).not.toHaveBeenCalled()
  service.stop()
})

it.each([
  'reuse off',
  'nonlocal',
  'no candidate',
  'open thread',
  'wrong provider',
  'other workspace'
] as const)('compatibility guard: %s takes one fresh path', async (caseName) => {
  const h = fixture(caseName !== 'reuse off')
  if (caseName === 'no candidate') {
    store.updateAutomationRun({ runId: h.prior.id, status: 'dispatch_failed' })
  }
  if (caseName === 'wrong provider') {
    store.updateAutomationRun({
      runId: h.prior.id,
      status: 'completed',
      providerSession: { providerSessionAgent: 'codex', providerSessionId: 'codex-thread' }
    })
  }
  if (caseName === 'other workspace') {
    store.updateAutomationRun({ runId: h.prior.id, status: 'completed', workspaceId: 'other' })
  }
  await h.launch(
    store.createAutomationRun(h.automation, Date.now()),
    caseName !== 'nonlocal',
    caseName === 'open thread' ? new Set(['recorded-thread']) : undefined
  )
  expect(h.create).toHaveBeenCalledTimes(1)
  expect(h.create.mock.calls[0][1]?.resumeProviderSession).toBeUndefined()
  expect(h.conversations.size).toBe(1)
})

// Run 107 of the Advertising routine (2026-10-04): its Claude thread was open in the live
// pane of the failed run 106, and the Codex-only "open elsewhere" rule sent it to a new tab.
describe('open thread in a live idle pane', () => {
  function livePane(h: ReturnType<typeof fixture>) {
    vi.spyOn(h.runtime, 'getTerminalHandleForPaneKey').mockReturnValue('handle-live')
    vi.spyOn(h.runtime, 'showTerminal').mockResolvedValue({
      handle: 'handle-live',
      connected: true,
      ptyId: 'pty-live',
      tabId: 'tab-live',
      leafId: 'leaf-live',
      worktreeId: h.workspaceId,
      title: 'Check'
    } as never)
    return vi
      .spyOn(h.runtime, 'sendAutomationInput')
      .mockResolvedValue({ handle: 'handle-live', accepted: true, bytesWritten: 1 })
  }
  const open = new Set(['recorded-thread'])
  const idle = new Map([['recorded-thread', 'tab-live:leaf-live']])

  it('Claude types the prompt into that pane instead of starting a fresh thread', async () => {
    const h = fixture()
    const send = livePane(h)
    const run = store.createAutomationRun(h.automation, Date.now())
    const result = await h.launch(run, true, open, idle)
    expect(h.create).not.toHaveBeenCalled()
    expect(send.mock.calls.map(([input]) => input.text)).toEqual([
      buildAgentPromptPasteBytes('Check'),
      AGENT_PROMPT_SUBMIT
    ])
    expect(send.mock.calls[0][0]).toMatchObject({
      workspaceId: h.workspaceId,
      paneKey: 'tab-live:leaf-live',
      ptyId: 'pty-live'
    })
    expect(result).toEqual({
      terminal: {
        handle: 'handle-live',
        worktreeId: h.workspaceId,
        tabId: 'tab-live',
        paneKey: 'tab-live:leaf-live',
        ptyId: 'pty-live',
        title: 'Check'
      },
      resume: { requested: 'recorded-thread', outcome: 'resumed' },
      reused: true
    })
  })

  it('Codex still starts fresh, because it refuses a thread open elsewhere', async () => {
    const h = fixture(true, 'codex')
    const send = livePane(h)
    const result = await h.launch(
      store.createAutomationRun(h.automation, Date.now()),
      true,
      open,
      idle
    )
    expect(send).not.toHaveBeenCalled()
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.create.mock.calls[0][1]?.resumeProviderSession).toBeUndefined()
    expect(result.resume).toEqual({
      requested: 'recorded-thread',
      outcome: 'fresh',
      reason: 'The recorded thread is still open in another pane; Codex would refuse to resume it.'
    })
  })

  it('a busy pane can start fresh, but a rejected write cannot duplicate delivery', async () => {
    const busy = fixture()
    const busySend = livePane(busy)
    await busy.launch(store.createAutomationRun(busy.automation, Date.now()), true, open, new Map())
    expect(busySend).not.toHaveBeenCalled()
    expect(busy.create).toHaveBeenCalledTimes(1)

    const refused = fixture()
    livePane(refused).mockRejectedValueOnce(new Error('automation_terminal_authority_changed'))
    await expect(
      refused.launch(store.createAutomationRun(refused.automation, Date.now()), true, open, idle)
    ).rejects.toThrow('automation_terminal_authority_changed')
    expect(refused.create).not.toHaveBeenCalled()
  })
})
