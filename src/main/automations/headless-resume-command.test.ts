import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStore, makeRepo, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/omni-runtime'
import { launchHeadlessAutomationTerminal } from './headless-dispatch'
import { prepareClaudeResumeLaunch } from '../claude/claude-resume-launch'
import { resolveCodexResumeLaunch } from '../ipc/pty/host-env/codex-resume'
import { UNVERIFIED_CODEX_RESUME_ERROR } from '../codex/codex-unverified-resume-launch'
import type { TuiAgent } from '../../shared/tui-agent'

type SpawnArgs = Parameters<
  NonNullable<NonNullable<Parameters<OrcaRuntimeService['setPtyController']>[0]>['spawn']>
>[0]

let store: ReturnType<typeof createStore>
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'routine-resume-command-'))
  store = createStore()
})
afterEach(async () => {
  await store.flushAsync()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

function fixture(agentId: TuiAgent) {
  const repo = makeRepo()
  store.addRepo(repo)
  const workspaceId = `${repo.id}::${repo.path}`
  const thread = randomUUID()
  const automation = store.createAutomation({
    name: 'Check',
    prompt: 'Review the routine',
    agentId,
    projectId: repo.id,
    workspaceMode: 'existing',
    workspaceId,
    reuseSession: true,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: Date.now()
  })
  const prior = store.createAutomationRun(automation, Date.now() - 1000)
  store.updateAutomationRun({
    runId: prior.id,
    status: 'completed',
    workspaceId,
    providerSession: {
      providerSessionAgent: agentId as 'claude' | 'codex',
      providerSessionId: thread
    }
  })
  const runtime = new OrcaRuntimeService(store)
  const workspace = { id: workspaceId, repoId: repo.id, path: repo.path, repo, connectionId: null }
  Object.assign(runtime, {
    resolveWorktreeSelector: async () => workspace,
    resolveTerminalWorkspaceLaunchScope: async () => workspace,
    markWorkspaceTrustedForAgent: async () => {}
  })
  const spawn = vi.fn(async (args: SpawnArgs) => {
    args.onResumePrepared?.(args.resumeProviderSession ?? null)
    return { id: randomUUID() }
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const launch = () => {
    const run = store.createAutomationRun(automation, Date.now())
    return launchHeadlessAutomationTerminal({
      runtime,
      automation,
      run,
      runs: store.listAutomationRuns(automation.id),
      localWorkspace: true,
      launch: {
        agent: agentId,
        prompt: automation.prompt,
        launchCause: {
          trigger: 'automation',
          reference: { automationId: automation.id, automationRunId: run.id }
        }
      }
    })
  }
  return { runtime, automation, prior, spawn, launch, thread }
}

it.each(['claude', 'codex'] as const)(
  '%s sends the recorded resume selector and routine prompt to the PTY controller for all three runs',
  async (agent) => {
    const h = fixture(agent)
    for (let i = 0; i < 3; i++) {
      const result = await h.launch()
      expect(result.resume).toMatchObject({ requested: h.thread, outcome: 'resumed' })
    }
    expect(h.spawn).toHaveBeenCalledTimes(3)
    const commands = h.spawn.mock.calls.map(([args]) => args.command as string)
    const selector = agent === 'claude' ? "'--resume'" : "'resume'"
    for (const command of commands) {
      expect(command).toContain(`${selector} '${h.thread}'`)
      expect(command).toContain("'Review the routine'")
    }
    expect(
      new Set(commands.map((command) => command.match(/'(?:--resume|resume)' '([^']+)'/)?.[1]))
    ).toEqual(new Set([h.thread]))
    expect(h.spawn.mock.calls[0][0].launchCause).toMatchObject({
      reference: { automationId: h.automation.id }
    })
  }
)

it('missing Claude transcript prepares no resume process, launches one fresh process and records fresh', async () => {
  const h = fixture('claude')
  store.updateAutomationRun({
    runId: h.prior.id,
    status: 'completed',
    providerSession: {
      providerSessionAgent: 'claude',
      providerSessionId: h.thread,
      providerSessionTranscriptPath: join(testState.dir, 'missing.jsonl')
    }
  })
  let processes = 0
  h.spawn.mockImplementation(async (args) => {
    await prepareClaudeResumeLaunch(args)
    processes++
    return { id: randomUUID() }
  })
  const result = await h.launch()
  expect(h.spawn).toHaveBeenCalledTimes(2)
  expect(processes).toBe(1)
  expect(result.resume).toMatchObject({
    requested: h.thread,
    outcome: 'fresh',
    reason: 'Claude resume transcript is missing and no verified fallback is available.'
  })
  expect(h.spawn.mock.calls[1][0].command).not.toContain('--resume')
})

it('unverified Codex resume with a routine prompt falls back to one fresh process', async () => {
  const h = fixture('codex')
  let processes = 0
  h.spawn.mockImplementation(async (args) => {
    if (args.resumeProviderSession) {
      await resolveCodexResumeLaunch(args.command, {
        providerSession: args.resumeProviderSession,
        preparation: Promise.resolve({ outcome: 'fresh', claimedCodexProvenance: true })
      })
    }
    processes++
    return { id: randomUUID() }
  })
  const result = await h.launch()
  expect(h.spawn).toHaveBeenCalledTimes(2)
  expect(processes).toBe(1)
  expect(result.resume).toMatchObject({ outcome: 'fresh', reason: UNVERIFIED_CODEX_RESUME_ERROR })
  expect(h.spawn.mock.calls[1][0].command).not.toContain("'resume'")
})
