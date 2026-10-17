import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { configureGoldenStubAgent, getGoldenStubAgentLaunchEnv } from './helpers/golden-stub-agent'
import { cleanupE2EProfileCrashpad } from './helpers/electron-crashpad-cleanup'
import {
  captureElectronLaunchDescendants,
  cleanupElectronLaunchDescendants,
  type LaunchCleanupSnapshot
} from './helpers/electron-launch-descendant-cleanup'
import { cleanupE2EProfileRuntime } from './helpers/electron-process-shutdown'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForTerminalOutput } from './helpers/terminal'

const scratch = path.join(os.tmpdir(), `orca-work-decision-restart-${randomUUID()}`)
const controlPath = path.join(scratch, 'question.json')
const receiptPath = path.join(scratch, 'received.jsonl')

test.beforeAll(() => mkdirSync(scratch, { recursive: true }))
test.afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function inputs(): { revision: string; input: string }[] {
  try {
    return readFileSync(receiptPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function seededRepoPathOrSkip(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  return repoPath
}

async function snapshot(page: Page, paneKey: string): Promise<unknown> {
  return await page.evaluate((paneKey) => {
    const s = window.__store!.getState()
    const status = s.agentStatusByPaneKey[paneKey]
    return {
      activeTabId: s.activeTabId,
      activeWorktreeId: s.activeWorktreeId,
      toasts: [...document.querySelectorAll('[data-sonner-toast]')].map((t) =>
        (t as HTMLElement).innerText.slice(0, 200)
      ),
      status: status
        ? {
            state: status.state,
            restoredUnconfirmed: status.restoredUnconfirmed ?? false,
            interactivePrompt: status.interactivePrompt?.slice(0, 120)
          }
        : null
    }
  }, paneKey)
}

test('a click on a Work decision reaches a question that was pending across an app restart', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo, {
    ...(getGoldenStubAgentLaunchEnv() as Record<string, string>),
    GOLDEN_STUB_AGENT_TITLE: 'claude',
    GOLDEN_STUB_QUESTION_CONTROL: controlPath
  })
  const closed: { proc: ChildProcess; snapshot: LaunchCleanupSnapshot | undefined }[] = []
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  // Why: release Crashpad on close, but preserve captured PTY descendants until final disposal.
  const close = async (app: ElectronApplication): Promise<void> => {
    let proc: ChildProcess | undefined
    const errors: unknown[] = []
    const steps = [
      async () => {
        proc = app.process()
        const snapshot = captureElectronLaunchDescendants(proc)
        closed.push({ proc, snapshot })
      },
      async () => await session.close(app),
      async () => await cleanupE2EProfileRuntime(session.userDataDir),
      async () => {
        if (proc) {
          await cleanupE2EProfileCrashpad(session.userDataDir, proc.spawnfile)
        }
      }
    ]
    for (const step of steps) {
      try {
        await step()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, 'Restart launch cleanup failed')
    }
  }
  let lifecycleError: unknown
  let lifecycleFailed = false
  const cleanupErrors: unknown[] = []
  try {
    const first = await session.launch()
    firstApp = first.app
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    await waitForSessionReady(first.page)
    await configureGoldenStubAgent(first.page, { agent: 'claude' })
    await first.page.evaluate((worktreeId) => {
      const state = window.__store!.getState()
      state.createTab(worktreeId, undefined, undefined, {
        launchAgent: 'claude',
        viewMode: 'terminal',
        pendingStartup: {
          command: 'golden-stub-agent',
          launchAgent: 'claude',
          startupCommandDelivery: 'shell-ready'
        }
      } as never)
      state.setActiveTabType('terminal')
    }, worktreeId)
    await waitForTerminalOutput(first.page, 'GOLDEN_STUB_AGENT_READY', 30_000)
    const descriptor = await waitForActivePaneHookDescriptor(first.page)
    const endpoint = await readHookEndpoint(first.app)
    writeFileSync(
      controlPath,
      JSON.stringify({
        revision: 'needs',
        screenOnly: false,
        endpoint,
        sessionId: randomUUID(),
        receiptPath,
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId
      }),
      { mode: 0o600 }
    )
    await expect
      .poll(
        () =>
          first.page.evaluate(
            (paneKey) =>
              window.__store!.getState().agentStatusByPaneKey[paneKey]?.interactivePrompt ?? null,
            descriptor.paneKey
          ),
        { timeout: 30_000 }
      )
      .not.toBeNull()
    // Why a second tab: after the restart the question's own terminal is not the one on screen.
    await first.page.evaluate((worktreeId) => {
      const state = window.__store!.getState()
      state.createTab(worktreeId)
      state.setActiveTabType('terminal')
    }, worktreeId)
    await close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    await second.page.evaluate(() => window.__store!.getState().openWorkPage())
    const decisions = second.page.getByRole('region', { name: 'Needs You — Questions' })
    await expect(decisions.getByText(/Paired fixture needs: pick the test marker/)).toBeVisible({
      timeout: 60_000
    })
    await testInfo.attach('before-click', {
      body: Buffer.from(JSON.stringify(await snapshot(second.page, descriptor.paneKey), null, 2)),
      contentType: 'application/json'
    })
    const readPending = () =>
      second.page.evaluate(async () => {
        const response = await window.api.runtime.call({
          method: 'sessionDecisions.list',
          params: {}
        })
        if (!response.ok) {
          throw new Error(`${response.error.code}: ${response.error.message}`)
        }
        return (
          response.result as {
            decisions: { key: string; paneKey: string; toolUseId: string | null }[]
          }
        ).decisions
      })
    const beforeAnswer = (await readPending()).filter(
      (row) => row.paneKey === descriptor.paneKey && row.toolUseId === 'fixture-needs'
    )
    expect(beforeAnswer).toHaveLength(1)
    const decisionKey = beforeAnswer[0]!.key
    await testInfo.attach('exact-native-key-before-answer', {
      body: Buffer.from(JSON.stringify({ decisionKey, beforeAnswer }, null, 2)),
      contentType: 'application/json'
    })
    await decisions.getByRole('button', { name: /Blue/ }).click()
    try {
      await expect
        .poll(() => inputs(), { timeout: 10_000 })
        .toEqual([{ revision: 'needs', input: '1' }])
      await expect
        .poll(async () => (await readPending()).map((row) => row.key), { timeout: 10_000 })
        .not.toContain(decisionKey)
      await expect(decisions.getByText(/Paired fixture needs: pick the test marker/)).toHaveCount(0)
      await expect(decisions).toHaveAttribute('data-work-decisions', '0')
      // Reopening Work remounts the queue and rules out its optimistic per-mount suppression.
      await second.page.evaluate(() => window.__store!.getState().closeWorkPage())
      await expect(decisions).toHaveCount(0)
      await second.page.evaluate(() => window.__store!.getState().openWorkPage())
      await expect(decisions).toBeVisible()
      await expect(decisions).toHaveAttribute('data-work-decisions', '0')
      await expect(decisions.getByText(/Paired fixture needs: pick the test marker/)).toHaveCount(0)
      const hookReceipts = readFileSync(`${receiptPath}.hooks.jsonl`, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(hookReceipts).toContainEqual(
        expect.objectContaining({
          event: 'PostToolUse',
          toolUseId: 'fixture-needs',
          endpointSource: 'managed-stable-file',
          credentialsRefreshedSinceQuestion: true,
          status: 204
        })
      )
      await testInfo.attach('actual-post-answer-hook-receipts', {
        body: Buffer.from(JSON.stringify(hookReceipts, null, 2)),
        contentType: 'application/json'
      })
      const afterAnswer = await readPending()
      expect(afterAnswer.map((row) => row.key)).not.toContain(decisionKey)
      await testInfo.attach('exact-native-key-resolved-after-work-remount', {
        body: Buffer.from(
          JSON.stringify({ decisionKey, afterAnswer, inputReceipts: inputs() }, null, 2)
        ),
        contentType: 'application/json'
      })
    } finally {
      await testInfo.attach('after-click', {
        body: Buffer.from(
          JSON.stringify(
            { ...((await snapshot(second.page, descriptor.paneKey)) as object), inputs: inputs() },
            null,
            2
          )
        ),
        contentType: 'application/json'
      })
      await second.page.screenshot({ path: testInfo.outputPath('after-click.png') })
    }

    // The answer attached the terminal without its pane; opening it afterwards still shows it live.
    await second.page.evaluate((tabId) => {
      const state = window.__store!.getState()
      state.closeWorkPage()
      state.setActiveTab(tabId)
      state.setActiveTabType('terminal')
    }, descriptor.paneKey.split(':')[0]!)
    await waitForTerminalOutput(second.page, 'FLEET_UI_RECEIPT_needs=Blue', 30_000)
  } catch (error) {
    lifecycleError = error
    lifecycleFailed = true
  } finally {
    const errors = cleanupErrors
    const steps = [
      async () => {
        if (secondApp) {
          await close(secondApp)
        }
      },
      async () => {
        if (firstApp) {
          await close(firstApp)
        }
      },
      async () => await session.dispose(),
      async () => {
        for (const { proc, snapshot } of closed) {
          try {
            const receipt = await cleanupElectronLaunchDescendants(proc, snapshot)
            console.log(
              '[e2e:final-launch-cleanup-v1]',
              JSON.stringify({ phase: 'after-session-dispose', snapshot, receipt })
            )
          } catch (error) {
            errors.push(error)
          }
        }
      }
    ]
    for (const step of steps) {
      try {
        await step()
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      lifecycleFailed ? [lifecycleError, ...cleanupErrors] : cleanupErrors,
      'Native restart lifecycle cleanup failed'
    )
  }
  if (lifecycleFailed) {
    throw lifecycleError
  }
})
