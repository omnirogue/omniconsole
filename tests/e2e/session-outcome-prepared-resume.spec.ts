import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { getOrcaProfileDataFile } from '../../src/main/omni-profiles/profile-storage-paths'
import { runProcessSync } from '../../src/shared/child-process/run-process'
import { normalizeSessionChain, type SessionChain } from '../../src/shared/session-chain-types'
import { reviseSessionOutcomeSet } from '../../src/shared/session-outcome-state'
import {
  sessionOutcomeActionKey,
  sessionOutcomeSetSchema
} from '../../src/shared/session-outcome-types'
import { expect, forwardElectronProcessLogs, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { cleanupE2EProfileCrashpad } from './helpers/electron-crashpad-cleanup'
import {
  cleanupE2EDaemons,
  cleanupE2EProfileRuntime,
  closeElectronAppForE2E
} from './helpers/electron-process-shutdown'
import { FAKE_AGENT_WINDOWS_SHELL } from './helpers/fake-agent-command-override'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForTerminalOutput } from './helpers/terminal'
import {
  cleanupDeterministicOutcomeAgent,
  clearDeterministicOutcomeAgentLedger,
  deterministicOutcomeAgentCommand,
  deterministicOutcomeAgentEnv,
  encodedOutcomeInstruction,
  readDeterministicOutcomeAgentLedger
} from './helpers/session-outcome-deterministic-agent'
import {
  openOutcomeUpNext,
  outcomeConversationRow,
  outcomeNeedsYouRow
} from './helpers/session-outcome-conversation'

type OutcomeProgress = {
  chain: SessionChain
  lifecycle: string
  phase: string
  attention: unknown[]
}

function createWorkspace(): string {
  const workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-resume-work-')))
  writeFileSync(path.join(workspace, 'README.md'), 'Disposable prepared recovery fixture.\n')
  for (const args of [
    ['init'],
    ['add', 'README.md'],
    [
      '-c',
      'user.name=Orca E2E',
      '-c',
      'user.email=orca-e2e@example.invalid',
      'commit',
      '-m',
      'Seed recovery fixture'
    ]
  ]) {
    const result = runProcessSync({ program: 'git', args, cwd: workspace })
    expect(result.code, result.stderr).toBe(0)
  }
  return workspace
}

/** Profile is offline here: seed the exact durable boundary before workerStart, without a product failpoint. */
function seedPreparedCheckpoint(statePath: string, chain: SessionChain, outputPath: string): void {
  const now = Date.now()
  const action = {
    id: 'write',
    agent: 'codex' as const,
    authority: 'existing-user-authority' as const,
    conditionIds: ['file'],
    instruction: encodedOutcomeInstruction({
      outcomeId: 'result',
      outputPath,
      contents: 'Exactly one worker after host recovery.\n'
    })
  }
  const set = reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'result',
          title: 'Prepared recovery result',
          finish: 'complete',
          dependsOn: [],
          conditions: [{ id: 'file', kind: 'file', target: outputPath }],
          actions: [action]
        }
      ]
    },
    {
      owner: 'execution-host',
      hostId: 'local',
      state: 'owned',
      epoch: randomUUID(),
      sourceReady: true,
      sourceVersion: 'seeded-prelaunch-checkpoint'
    },
    now
  )
  set.attempts.push({
    id: 'prepared_checkpoint',
    outcomeId: 'result',
    actionId: action.id,
    actionKey: sessionOutcomeActionKey(action),
    outcomeRevision: 1,
    state: 'prepared',
    startedAt: now,
    updatedAt: now
  })
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as { sessionChains?: SessionChain[] }
  const prepared = normalizeSessionChain({
    ...chain,
    outcomeSet: sessionOutcomeSetSchema.parse(set)
  })
  if (!prepared?.outcomeSet) {
    throw new Error('Prepared checkpoint does not survive host normalization')
  }
  state.sessionChains = [...(state.sessionChains ?? []), prepared]
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

async function closeProfileApp(app: ElectronApplication, userDataDir: string): Promise<void> {
  const child = app.process()
  try {
    // Ordinary app quit preserves source tabs. terminal.close is a user-visible
    // pane removal and would intentionally erase the row that owns this outcome.
    await app.evaluate(({ app }) => app.quit())
    await expect
      .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 30_000 })
      .toBe(true)
  } finally {
    await cleanupE2EProfileRuntime(userDataDir)
    await cleanupE2EDaemons(userDataDir)
    if (child.exitCode !== null || child.signalCode !== null) {
      await cleanupE2EProfileCrashpad(userDataDir, child.spawnfile)
    }
    await closeElectronAppForE2E(app)
  }
}

/** The finished run, opened from its row under Done: its Up next header says Completed. */
async function expectCompletedOutcome(page: Page, paneKey: string): Promise<void> {
  const upNext = await openOutcomeUpNext(page, await outcomeConversationRow(page, paneKey, 'done'))
  await expect(upNext.locator('[data-up-next-header-status="completed"]')).toContainText('Complete')
}

test.afterAll(() => cleanupDeterministicOutcomeAgent())

test('the host recovers a prepared checkpoint once, asks nobody, and preserves completion across restart', async (// oxlint-disable-next-line no-empty-pattern -- This test owns three launches of one disposable profile.
{}, testInfo) => {
  test.setTimeout(240_000)
  testInfo.annotations.push({
    type: 'evidence-scope',
    description:
      'Seeded durable prepared checkpoint; real Electron restarts, the host recovery ladder, rendered status, RPC, PTY, worker_done and file evidence. Deterministic processes, no external model provider.'
  })
  clearDeterministicOutcomeAgentLedger()
  const agentEnv = Object.fromEntries(
    Object.entries(deterministicOutcomeAgentEnv()).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )
  const session = createRestartSession(testInfo, {
    ...agentEnv,
    ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1'
  })
  const workspace = createWorkspace()
  const outputPath = path.join(workspace, 'prepared-resume-result.txt')
  let app: ElectronApplication | null = null
  try {
    let launched = await session.launch()
    app = launched.app
    forwardElectronProcessLogs(app, testInfo)
    // The root JSON is a one-time migration source. Runtime state lives in the active profile.
    const profileId = await launched.page.evaluate(
      async () => (await window.api.orcaProfiles.list()).activeProfileId
    )
    const statePath = getOrcaProfileDataFile(profileId, session.userDataDir)
    await launched.page.evaluate(
      async ({ command, windowsShell }) => {
        await window.__store!.getState().updateSettings({
          defaultTuiAgent: 'codex',
          agentCmdOverrides: { codex: command, cursor: command },
          ...(navigator.platform.startsWith('Win') ? { terminalWindowsShell: windowsShell } : {})
        })
      },
      { command: deterministicOutcomeAgentCommand, windowsShell: FAKE_AGENT_WINDOWS_SHELL }
    )
    const worktreeId = await attachRepoAndOpenTerminal(launched.page, workspace)
    await ensureTerminalVisible(launched.page)
    await launched.page.evaluate((command) => {
      const state = window.__store!.getState()
      state.createTab(state.activeWorktreeId!, undefined, undefined, {
        launchAgent: 'cursor',
        viewMode: 'terminal',
        pendingStartup: {
          command: `${command} --outcome-source`,
          launchAgent: 'cursor',
          startupCommandDelivery: 'shell-ready'
        }
      })
      state.setActiveTabType('terminal')
    }, deterministicOutcomeAgentCommand)
    await waitForTerminalOutput(launched.page, 'Deterministic outcome agent', 30_000)
    const { paneKey } = await waitForActivePaneHookDescriptor(launched.page)
    const now = Date.now()
    const chain: SessionChain = {
      id: 'prepared_resume',
      workspacePath: workspace,
      worktreeId,
      hostId: 'local',
      sourcePaneKey: paneKey,
      sourceRowKey: JSON.stringify(['local', worktreeId, paneKey]),
      auto: true,
      steps: [],
      currentIndex: 0,
      state: 'waiting',
      createdAt: now,
      updatedAt: now
    }
    await closeProfileApp(app, session.userDataDir)
    app = null
    seedPreparedCheckpoint(statePath, chain, outputPath)

    launched = await session.launch()
    app = launched.app
    forwardElectronProcessLogs(app, testInfo)
    await waitForSessionReady(launched.page)
    expect(
      await launched.page.evaluate(
        async () => (await window.api.orcaProfiles.list()).activeProfileId
      )
    ).toBe(profileId)
    const client = new RuntimeClient(session.userDataDir, 30_000, null, null)
    const progress = async () =>
      (await client.call<OutcomeProgress>('sessionChain.outcomeProgress', { id: chain.id })).result
    // A launch that provably never started is the host's own to retry once its backoff runs out:
    // the run reads as recovering and asks its owner nothing. One snapshot, so the attempt below
    // is the one that phase was read from.
    let held!: OutcomeProgress
    await expect
      .poll(
        async () => {
          held = await progress()
          return held.phase
        },
        { timeout: 45_000 }
      )
      .toBe('recovering')
    expect(held).toMatchObject({ lifecycle: 'waiting', attention: [] })
    expect(held.chain.outcomeSet!.attempts).toMatchObject([
      {
        id: 'prepared_checkpoint',
        state: 'blocked',
        launchDisposition: 'not-started',
        failure: { code: 'launch-not-started' }
      }
    ])
    // Wherever the backoff has got to by now, this is never the owner's to answer: the row is not
    // under Needs you, and its Up next header never asks.
    const row = await outcomeConversationRow(launched.page, paneKey)
    await expect(outcomeNeedsYouRow(launched.page, paneKey)).toHaveCount(0)
    await openOutcomeUpNext(launched.page, row)
    await expect(launched.page.locator('[data-up-next-header-status="needs-you"]')).toHaveCount(0)
    await launched.page.screenshot({ path: testInfo.outputPath('prepared-outcome-recovering.png') })
    await launched.page.keyboard.press('Escape')
    // Nobody presses anything: the recovery ladder replaces the launch that never started.
    await expect
      .poll(async () => (await progress()).lifecycle, { timeout: 90_000 })
      .toBe('complete')
    expect(readFileSync(outputPath, 'utf8')).toBe('Exactly one worker after host recovery.\n')
    expect(
      readDeterministicOutcomeAgentLedger().filter((event) => event.event === 'accepted')
    ).toHaveLength(1)
    expect(
      readDeterministicOutcomeAgentLedger().filter((event) => event.event === 'reported')
    ).toMatchObject([{ status: 0 }])
    const completed = (await progress()).chain.outcomeSet!
    expect(completed.attempts).toHaveLength(2)
    expect(completed.attempts).toMatchObject([
      { id: 'prepared_checkpoint', state: 'retryable', launchDisposition: 'not-started' },
      { state: 'completed', dispatchId: expect.any(String) }
    ])
    // This test owns restart launches outside the shared page fixture, so capture
    // its rendered context explicitly before teardown removes the window.
    await launched.page.screenshot({
      path: testInfo.outputPath('prepared-outcome-after-worker.png')
    })
    await testInfo.attach('prepared-outcome-after-worker', {
      contentType: 'application/json',
      body: JSON.stringify(
        await launched.page.evaluate(() => {
          const state = window.__store!.getState()
          return {
            activeWorktreeId: state.activeWorktreeId,
            activeTabId: state.activeTabId,
            activeTabType: state.activeTabType,
            activeView: state.activeView,
            text: document.body.innerText,
            rows: [...document.querySelectorAll('[data-session-row]')].map((node) => ({
              row: node.getAttribute('data-session-row'),
              group: node.closest('[data-session-group]')?.getAttribute('data-session-group'),
              text: node.textContent
            }))
          }
        }),
        null,
        2
      )
    })
    await expectCompletedOutcome(launched.page, paneKey)
    await expect(
      launched.page.getByRole('button', { name: 'Resume saved work', exact: true })
    ).toHaveCount(0)

    await closeProfileApp(app, session.userDataDir)
    app = null
    launched = await session.launch()
    app = launched.app
    forwardElectronProcessLogs(app, testInfo)
    await waitForSessionReady(launched.page)
    await expect
      .poll(async () => (await progress()).lifecycle, { timeout: 30_000 })
      .toBe('complete')
    await launched.page.waitForTimeout(4_500)
    expect((await progress()).chain.outcomeSet!.attempts).toEqual(completed.attempts)
    expect((await progress()).chain.outcomeSet!.outcomes[0].evidence).toEqual(
      completed.outcomes[0].evidence
    )
    expect(
      readDeterministicOutcomeAgentLedger().filter((event) => event.event === 'accepted')
    ).toHaveLength(1)
    await expectCompletedOutcome(launched.page, paneKey)
  } finally {
    try {
      if (app) {
        await closeProfileApp(app, session.userDataDir)
      }
    } finally {
      await session.dispose()
      rmSync(workspace, { recursive: true, force: true })
    }
  }
})
