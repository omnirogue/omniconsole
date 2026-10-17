import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_READY_MARKER
} from './helpers/golden-stub-agent'
import {
  ensureTerminalVisible,
  switchToOtherWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForTerminalOutput } from './helpers/terminal'

/**
 * `omni session show`: "what's the status on X?" pulls X into view on the right, highlighted,
 * through the real CLI against the running app's own runtime.
 */

test.use({ launchEnv: { ...getGoldenStubAgentLaunchEnv(), GOLDEN_STUB_AGENT_TITLE: 'claude' } })

const CLI_PATH = path.join(process.cwd(), 'out', 'cli', 'index.js')

type ShowJson = {
  shown: boolean
  placement: string | null
  target: { paneKey: string; tabId: string } | null
}

function runCli(userDataPath: string, args: string[]): { status: number; json: unknown } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, ORCA_USER_DATA_PATH: userDataPath }
    })
    return { status: 0, json: (JSON.parse(stdout) as { result?: unknown }).result }
  } catch (error) {
    const err = error as { status?: number; stdout?: string }
    let json: unknown = null
    try {
      json = (JSON.parse(err.stdout ?? '') as { result?: unknown }).result
    } catch {
      json = null
    }
    return { status: err.status ?? 1, json }
  }
}

async function userDataPathOf(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
}

/** SETUP: a stub Claude conversation in its own tab of the active workspace, in front. */
async function startConversation(page: Page): Promise<{ paneKey: string; tabId: string }> {
  await configureGoldenStubAgent(page, { agent: 'claude' })
  const tabId = await page.evaluate(() => {
    const state = window.__store!.getState()
    const tab = state.createTab(state.activeWorktreeId!, undefined, undefined, {
      launchAgent: 'claude',
      pendingStartup: {
        command: 'golden-stub-agent',
        launchAgent: 'claude',
        startupCommandDelivery: 'shell-ready'
      }
    } as never)
    state.setActiveTabType('terminal')
    return tab.id
  })
  await waitForTerminalOutput(page, GOLDEN_STUB_READY_MARKER, 20_000)
  const { paneKey } = await waitForActivePaneHookDescriptor(page)
  return { paneKey, tabId }
}

async function setup(electronApp: ElectronApplication, orcaPage: Page) {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const userDataPath = await userDataPathOf(electronApp)
  const a = await startConversation(orcaPage)
  const b = await startConversation(orcaPage)
  return { worktreeId, userDataPath, a, b }
}

/** Each split group's front terminal tab, left to right. */
async function frontTabs(page: Page, worktreeId: string): Promise<(string | null)[]> {
  return page.evaluate((id) => {
    const state = window.__store!.getState()
    return (state.groupsByWorktree[id] ?? []).map((group) => {
      const tab = state.unifiedTabsByWorktree[id]?.find((t) => t.id === group.activeTabId)
      return tab?.entityId ?? null
    })
  }, worktreeId)
}

test.describe('omni session show', () => {
  test('a same-workspace conversation splits in on the right, rim flashing', async ({
    electronApp,
    orcaPage
  }) => {
    const { worktreeId, userDataPath, a, b } = await setup(electronApp, orcaPage)
    expect(await frontTabs(orcaPage, worktreeId)).toEqual([b.tabId])

    const shown = runCli(userDataPath, ['session', 'show', '--pane', a.paneKey, '--json'])
    expect(shown.status).toBe(0)
    expect(shown.json).toMatchObject({
      shown: true,
      placement: 'split'
    } satisfies Partial<ShowJson>)

    // B stays on the left, A comes in on the right.
    await expect.poll(() => frontTabs(orcaPage, worktreeId)).toEqual([b.tabId, a.tabId])
    await expect(orcaPage.locator('.pane.pane-focus-rim-flash')).toHaveCount(1)
  })

  test('--replace keeps the plain focus behaviour: one view, the target in front', async ({
    electronApp,
    orcaPage
  }) => {
    const { worktreeId, userDataPath, a } = await setup(electronApp, orcaPage)

    const shown = runCli(userDataPath, [
      'session',
      'show',
      '--pane',
      a.paneKey,
      '--replace',
      '--json'
    ])
    expect(shown.json).toMatchObject({ shown: true, placement: 'replaced' })
    await expect.poll(() => frontTabs(orcaPage, worktreeId)).toEqual([a.tabId])
  })

  test('a conversation from another workspace opens the Grid', async ({
    electronApp,
    orcaPage
  }) => {
    const { worktreeId, userDataPath, a } = await setup(electronApp, orcaPage)
    const other = await switchToOtherWorktree(orcaPage, worktreeId)
    test.skip(!other, 'the fixture repo has a single workspace')

    const shown = runCli(userDataPath, ['session', 'show', '--pane', a.paneKey, '--json'])
    expect(shown.json).toMatchObject({ shown: true, placement: 'grid' })
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeView))
      .toBe('grid')
  })
})
