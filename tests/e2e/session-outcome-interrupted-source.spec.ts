import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { SessionChain } from '../../src/shared/session-chain-types'
import type {
  RuntimeTerminalClose,
  RuntimeTerminalListResult
} from '../../src/shared/runtime-terminal-contracts'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForTerminalOutput } from './helpers/terminal'
import { FAKE_AGENT_WINDOWS_SHELL } from './helpers/fake-agent-command-override'
import { cleanupE2EProfileCrashpad } from './helpers/electron-crashpad-cleanup'
import {
  cleanupE2EDaemons,
  cleanupE2EProfileRuntime,
  closeElectronAppForE2E
} from './helpers/electron-process-shutdown'
import {
  cleanupDeterministicOutcomeAgent,
  clearDeterministicOutcomeAgentLedger,
  deterministicOutcomeAgentCommand,
  deterministicOutcomeAgentEnv,
  encodedOutcomeInstruction,
  readDeterministicOutcomeAgentLedger,
  setDeterministicOutcomeSourceState
} from './helpers/session-outcome-deterministic-agent'
import {
  openOutcomeUpNext,
  outcomeConversationRow,
  outcomeNeedsYouRow
} from './helpers/session-outcome-conversation'

test.use({
  launchEnv: {
    ...deterministicOutcomeAgentEnv(),
    // Durable outcome ownership requires the real profile lock and daemon.
    ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1'
  }
})
test.afterAll(() => cleanupDeterministicOutcomeAgent())
test.afterEach(async ({ electronApp }) => {
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const electronProcess = electronApp.process()
  const client = new RuntimeClient(userDataDir, 10_000, null, null)
  try {
    // Every terminal belongs to this fresh fixture profile, including its seeded shell.
    const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
    for (const terminal of listed.result.terminals.filter((entry) => entry.connected)) {
      const closed = await client.call<{ close: RuntimeTerminalClose }>('terminal.close', {
        terminal: terminal.handle
      })
      expect(closed.result.close.ptyKilled, `Close did not stop ${terminal.handle}`).toBe(true)
    }
  } finally {
    try {
      await electronApp.evaluate(({ app }) => app.quit())
      await expect
        .poll(() => electronProcess.exitCode !== null || electronProcess.signalCode !== null, {
          timeout: 30_000
        })
        .toBe(true)
    } finally {
      // Release detached owners and their stdio before Playwright awaits its process channel.
      await cleanupE2EProfileRuntime(userDataDir)
      await cleanupE2EDaemons(userDataDir)
      // Crashpad is reparented to init and can retain the exited app's stderr pipe.
      if (electronProcess.exitCode !== null || electronProcess.signalCode !== null) {
        await cleanupE2EProfileCrashpad(userDataDir, electronProcess.spawnfile)
      }
      await closeElectronAppForE2E(electronApp)
    }
  }
})

test('a cancelled source hook holds the visible outcome until successful source completion', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  testInfo.annotations.push({
    type: 'evidence-scope',
    description:
      'Real isolated Electron, PTYs, authenticated hooks, runtime RPC, worker_done and files; deterministic processes, no external model provider.'
  })
  clearDeterministicOutcomeAgentLedger()
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await orcaPage.evaluate(
    async ({ command, windowsShell }) => {
      const state = window.__store!.getState()
      await state.updateSettings({
        defaultTuiAgent: 'codex',
        agentCmdOverrides: { codex: command, cursor: command },
        ...(navigator.platform.startsWith('Win') ? { terminalWindowsShell: windowsShell } : {})
      })
      state.createTab(state.activeWorktreeId!, undefined, undefined, {
        launchAgent: 'cursor',
        viewMode: 'terminal',
        pendingStartup: {
          command: `${command} --outcome-source`,
          launchAgent: 'cursor',
          startupCommandDelivery: 'shell-ready'
        }
      } as never)
      state.setActiveTabType('terminal')
    },
    { command: deterministicOutcomeAgentCommand, windowsShell: FAKE_AGENT_WINDOWS_SHELL }
  )
  await waitForTerminalOutput(orcaPage, 'Deterministic outcome agent', 30_000)
  const { paneKey } = await waitForActivePaneHookDescriptor(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000)
  let workspace = ''
  await expect
    .poll(
      async () => {
        const worktrees = await client.call<{ worktrees: { id: string; path: string }[] }>(
          'worktree.list',
          {}
        )
        workspace = worktrees.result.worktrees.find((entry) => entry.id === worktreeId)?.path ?? ''
        return workspace
      },
      { timeout: 30_000 }
    )
    .not.toBe('')
  await expect
    .poll(
      async () =>
        (await client.call<{ durableContinuation: boolean }>('sessionChain.outcomeCapabilities'))
          .result.durableContinuation
    )
    .toBe(true)
  const outputPath = path.join(workspace, 'interrupted-source-result.txt')
  const chain: SessionChain = {
    id: 'interrupted_source',
    workspacePath: workspace,
    worktreeId,
    hostId: 'local',
    sourcePaneKey: paneKey,
    sourceRowKey: JSON.stringify(['local', worktreeId, paneKey]),
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  const sourceState = async (state: 'working' | 'interrupted' | 'done') => {
    const before = readDeterministicOutcomeAgentLedger().length
    setDeterministicOutcomeSourceState(state)
    await expect
      .poll(
        () =>
          readDeterministicOutcomeAgentLedger()
            .slice(before)
            .find((event) => event.event === 'source-hook' && event.sourceState === state),
        { timeout: 15_000 }
      )
      .toMatchObject({ status: 204 })
  }
  await sourceState('working')
  await orcaPage.evaluate(
    async (serializedParams) => {
      const response = await window.api.runtime.call({
        method: 'sessionChain.commitOutcomes',
        params: JSON.parse(serializedParams)
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
    },
    JSON.stringify({
      chain,
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'result',
          title: 'Interrupted source result',
          finish: 'complete',
          dependsOn: [],
          conditions: [{ id: 'file', kind: 'file', target: outputPath }],
          actions: [
            {
              id: 'write',
              agent: 'codex',
              authority: 'existing-user-authority',
              instruction: encodedOutcomeInstruction({
                outcomeId: 'result',
                outputPath,
                contents: 'Exactly one resumed outcome worker.\n'
              }),
              conditionIds: ['file']
            }
          ]
        }
      ]
    })
  )
  await sourceState('interrupted')
  // An interrupted source may still be run again: the outcome WAITS on that session and asks its
  // owner nothing, so its row stays in Active and never enters Needs you (or Attention).
  const row = await outcomeConversationRow(orcaPage, paneKey, 'active')
  await expect(row.locator('[data-session-status="awaiting"]')).toContainText(
    'Waiting for source session',
    { timeout: 30_000 }
  )
  await expect(outcomeNeedsYouRow(orcaPage, paneKey)).toHaveCount(0)
  // The interruption itself is a diagnostic, so it reads in the row's details, never as an ask.
  await row.getByRole('button', { name: /^Show details for / }).click()
  const plan = orcaPage.locator(
    '[data-session-row-details] [data-work-plan-row="interrupted_source"]'
  )
  await expect(plan.locator('[data-run-detail]')).toContainText(
    'The source session was interrupted before it finished',
    { timeout: 30_000 }
  )
  await expect(plan).toHaveAttribute('data-run-phase', 'waiting')
  const upNext = await openOutcomeUpNext(orcaPage, row)
  await expect(upNext.locator('[data-up-next-header-status="waiting"]')).toContainText(
    'Waiting for source session'
  )
  await expect(orcaPage.locator('[data-up-next-header-status="needs-you"]')).toHaveCount(0)
  // Cover multiple host ticks: an immediate empty ledger would not prove that launch stayed held.
  await orcaPage.waitForTimeout(4_500)
  const progress = async () =>
    (
      await client.call<{
        chain: SessionChain
        lifecycle: string
        phase: string
        attention: unknown[]
      }>('sessionChain.outcomeProgress', { id: chain.id })
    ).result
  expect(await progress()).toMatchObject({ phase: 'waiting', lifecycle: 'waiting', attention: [] })
  expect((await progress()).chain.outcomeSet!.attempts).toHaveLength(0)
  expect(
    readDeterministicOutcomeAgentLedger().filter((event) => event.event === 'accepted')
  ).toHaveLength(0)
  expect(existsSync(outputPath)).toBe(false)
  await orcaPage.screenshot({ path: testInfo.outputPath('interrupted-outcome-waiting.png') })
  await orcaPage.keyboard.press('Escape')

  await sourceState('working')
  await sourceState('done')
  await expect.poll(async () => (await progress()).lifecycle, { timeout: 60_000 }).toBe('complete')
  expect(readFileSync(outputPath, 'utf8')).toBe('Exactly one resumed outcome worker.\n')
  expect(
    readDeterministicOutcomeAgentLedger().filter((event) => event.event === 'accepted')
  ).toHaveLength(1)
  expect(
    readDeterministicOutcomeAgentLedger().filter((event) => event.event === 'reported')
  ).toMatchObject([{ status: 0 }])
  const completed = (await progress()).chain.outcomeSet!.attempts
  expect(completed).toHaveLength(1)
  expect(completed[0]).toMatchObject({ state: 'completed', dispatchId: expect.any(String) })
  const finished = await openOutcomeUpNext(
    orcaPage,
    await outcomeConversationRow(orcaPage, paneKey, 'done')
  )
  await expect(finished.locator('[data-up-next-header-status="completed"]')).toContainText(
    'Complete',
    { timeout: 15_000 }
  )
})
