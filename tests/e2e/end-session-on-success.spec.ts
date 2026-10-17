import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getGoldenStubAgentLaunchEnv, GOLDEN_STUB_READY_MARKER } from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

/** The host-owned Done block closes successful work without closing an unanswered session. */

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

async function activePaneKey(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    const tabId = state.activeTabId!
    const leafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId
    return `${tabId}:${leafId}`
  })
}

// Why: the stub agent has no hooks; the status its hooks would report is seeded by hand.
async function seedStatus(page: Page, paneKey: string, state: 'working' | 'waiting' | 'done') {
  await page.evaluate(
    ({ key, state }) => {
      window
        .__store!.getState()
        .setAgentStatus(
          key,
          { state, prompt: 'Build the page', agentType: 'codex' },
          'Codex pane',
          { updatedAt: Date.now(), stateStartedAt: Date.now() }
        )
    },
    { key: paneKey, state }
  )
}

async function tabCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    Object.values(window.__store!.getState().tabsByWorktree).reduce(
      (sum, tabs) => sum + tabs.length,
      0
    )
  )
}

function sidebarRow(page: Page, paneKey: string): Locator {
  return page.locator(`[data-session-row*="${paneKey}"]`).first()
}

test('one Conversations label; ✓ ends the session on success and parks it in Needs you while it asks', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  // Why: the quick-launch menu lists only agents with verified availability, which the stub never
  // has in an isolated home; the stub runs in the open terminal instead, like a typed `codex`.
  const stub = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'golden-stub-agent')
  await execInTerminal(
    orcaPage,
    await waitForActivePanePtyId(orcaPage),
    `'${process.execPath}' '${path.join(stub, 'golden-stub-agent.js')}'`
  )
  await waitForTerminalOutput(orcaPage, GOLDEN_STUB_READY_MARKER, 20_000)
  const paneKey = await activePaneKey(orcaPage)
  await seedStatus(orcaPage, paneKey, 'working')

  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  const sidebar = orcaPage
    .locator('[data-contextual-tour-target="sidebar-navigation"]')
    .locator('..')
  await expect(orcaPage.getByRole('region', { name: 'Session folders' })).toBeVisible()
  // The sidebar names Conversations once: the tab below Agents. No destination, heading or group.
  await expect(orcaPage.locator('button[data-nav-group="sessions"]')).toHaveCount(0)
  await expect(sidebar.getByText(/^Conversations$/i)).toHaveCount(1)
  await expect(orcaPage.getByRole('group', { name: 'Active' })).toBeVisible()

  const row = sidebarRow(orcaPage, paneKey)
  await expect(row).toBeVisible()
  await row.hover()
  await row.getByRole('button', { name: 'Up next', exact: true }).click()
  const composer = orcaPage.locator('[data-up-next-chain]').last()
  await composer.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(
    composer.getByRole('button', { name: 'Close session', exact: true })
  ).toHaveAttribute('aria-pressed', 'true')
  const tabsBefore = await tabCount(orcaPage)
  await composer.getByRole('button', { name: 'Queue 1 new block', exact: true }).click()
  await expect(composer.locator('[data-up-next-block][data-kind="done"]')).toHaveAttribute(
    'data-state',
    'queued'
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('up-next-end-session.png') })
  await orcaPage.keyboard.press('Escape')

  // The agent asks something: nothing closes, and the row moves under Needs you.
  await seedStatus(orcaPage, paneKey, 'waiting')
  const needsYou = orcaPage.getByRole('group', { name: 'Needs you' })
  await expect(needsYou.locator(`[data-session-row*="${paneKey}"]`)).toBeVisible({
    timeout: 20_000
  })
  await expect(needsYou.locator('[data-session-plan-blocked="waiting"]').first()).toHaveText(
    'Needs your answer · the plan carries on after'
  )
  await expect(needsYou.getByText('Next session queued')).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('needs-you-while-asking.png') })
  expect(await tabCount(orcaPage)).toBe(tabsBefore)

  // Answered and back at work: out of Needs you, still open.
  await seedStatus(orcaPage, paneKey, 'working')
  await expect(needsYou.locator(`[data-session-row*="${paneKey}"]`)).toHaveCount(0, {
    timeout: 20_000
  })
  expect(await tabCount(orcaPage)).toBe(tabsBefore)

  // The work finishes: the session really closes, and Recently closed keeps it.
  await seedStatus(orcaPage, paneKey, 'done')
  await expect.poll(() => tabCount(orcaPage), { timeout: 60_000 }).toBe(tabsBefore - 1)
  await expect(
    orcaPage.getByText('Finished and closed. Reopen it from Recently closed.')
  ).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('closed-on-success.png') })
})
