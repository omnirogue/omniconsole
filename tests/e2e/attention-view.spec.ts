import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type AttentionSlotVisibility = {
  slotId: string
  empty: boolean
  visibleLeafIds: string[]
}

function attentionSidebarButton(page: Page) {
  return page.getByRole('button', { name: /^Attention(?:\s+\d+ need you)?$/ }).first()
}

/** The Attention primary lives inside the Work group, which starts closed. */
async function openAttention(page: Page): Promise<void> {
  const button = attentionSidebarButton(page)
  if ((await button.count()) === 0) {
    await page
      .getByRole('button', { name: /^Work(?:\s|$)/ })
      .first()
      .click()
    await button.waitFor({ timeout: 10_000 })
  }
  await button.click()
}

async function seedAgentStatus(
  page: Page,
  args: {
    paneKey: string
    state: 'blocked' | 'waiting' | 'working' | 'done'
    prompt: string
    startedAt: number
  }
): Promise<void> {
  await page.evaluate(({ paneKey, state, prompt, startedAt }) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state, prompt, agentType: 'codex', lastAssistantMessage: prompt },
        'Codex pane',
        { updatedAt: startedAt, stateStartedAt: startedAt }
      )
  }, args)
}

async function readAttentionSlots(page: Page): Promise<AttentionSlotVisibility[]> {
  return page.evaluate(() => {
    const hasInlineDisplayNoneBetween = (element: HTMLElement, root: HTMLElement): boolean => {
      let current: HTMLElement | null = element
      while (current) {
        if (current.style.display === 'none') {
          return true
        }
        if (current === root) {
          return false
        }
        current = current.parentElement
      }
      return false
    }
    return Array.from(document.querySelectorAll<HTMLElement>('[data-attention-slot]')).map(
      (slot) => ({
        slotId: slot.dataset.attentionSlot ?? '',
        empty: slot.hasAttribute('data-attention-slot-empty'),
        visibleLeafIds: Array.from(slot.querySelectorAll<HTMLElement>('[data-leaf-id]'))
          .filter((pane) => !hasInlineDisplayNoneBetween(pane, slot))
          .map((pane) => pane.dataset.leafId ?? '')
      })
    )
  })
}

test.describe('Attention view', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const hasPaneManager = await waitForActiveTerminalManager(orcaPage, 30_000)
      .then(() => true)
      .catch(() => false)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the live TerminalPane manager, so attention slots would only fail on harness setup.'
    )
    await waitForPaneCount(orcaPage, 1, 30_000)
  })

  test('shows the current terminal, a blank second screen, then the pane that needs the user', async ({
    orcaPage
  }, testInfo) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const [first, second] = snapshot.panes
    if (!first || !second) {
      throw new Error('Attention view test needs two split panes')
    }
    const activeLeafId = await orcaPage.evaluate(
      (tabId) => window.__store?.getState().terminalLayoutsByTabId[tabId]?.activeLeafId ?? null,
      snapshot.tabId
    )
    const currentPane = activeLeafId === second.leafId ? second : first
    const otherPane = currentPane === first ? second : first

    await openAttention(orcaPage)
    await expect(orcaPage.getByText('Nothing needs you')).toBeVisible()
    await expect
      .poll(() => readAttentionSlots(orcaPage), { timeout: 10_000 })
      .toMatchObject([
        { slotId: 'current', empty: false, visibleLeafIds: [currentPane.leafId] },
        { slotId: 'needs-you', empty: true, visibleLeafIds: [] }
      ])
    await orcaPage.screenshot({
      path: testInfo.outputPath('attention-view-blank.png'),
      animations: 'disabled'
    })

    const now = Date.now()
    const prompt = `ATTENTION_UUID_${now}`
    await seedAgentStatus(orcaPage, {
      paneKey: `${snapshot.tabId}:${otherPane.leafId}`,
      state: 'waiting',
      prompt,
      startedAt: now - 2_000
    })
    await expect(attentionSidebarButton(orcaPage)).toHaveAccessibleName(/1 need you/)
    await expect(orcaPage.getByText('1 need you').first()).toBeVisible()
    // Why: the waiting pane shares the current tab, so the current slot shows the whole tab.
    await expect
      .poll(() => readAttentionSlots(orcaPage), { timeout: 10_000 })
      .toMatchObject([
        {
          slotId: 'current',
          empty: false,
          visibleLeafIds: expect.arrayContaining([currentPane.leafId, otherPane.leafId])
        },
        { slotId: 'needs-you', empty: true }
      ])
    await expect(
      orcaPage.getByText('This pane is split inside your current tab, so it is shown on the left.')
    ).toBeVisible()
    await orcaPage.screenshot({
      path: testInfo.outputPath('attention-view-needs-you.png'),
      animations: 'disabled'
    })

    await seedAgentStatus(orcaPage, {
      paneKey: `${snapshot.tabId}:${otherPane.leafId}`,
      state: 'working',
      prompt,
      startedAt: now
    })
    await expect(orcaPage.getByText('Nothing needs you')).toBeVisible()
    await expect
      .poll(() => readAttentionSlots(orcaPage), { timeout: 10_000 })
      .toMatchObject([
        { slotId: 'current', visibleLeafIds: [currentPane.leafId] },
        { slotId: 'needs-you', empty: true }
      ])
  })

  test('sidebar rows and groups flag the pane that needs the user', async ({
    orcaPage
  }, testInfo) => {
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const pane = snapshot.panes[0]
    if (!pane) {
      throw new Error('Attention sidebar test needs a pane')
    }
    const now = Date.now()
    await seedAgentStatus(orcaPage, {
      paneKey: `${snapshot.tabId}:${pane.leafId}`,
      state: 'blocked',
      prompt: `ATTENTION_SIDEBAR_${now}`,
      startedAt: now - 5_000
    })
    await expect(
      orcaPage.locator('[data-worktree-card-surface][data-worktree-card-attention]').first()
    ).toBeVisible()
    await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
    const needsYou = orcaPage.getByRole('group', { name: 'Needs you' })
    await expect(needsYou).toBeVisible()
    await expect(needsYou.locator('[data-needs-attention]').first()).toBeVisible()
    await orcaPage.screenshot({
      path: testInfo.outputPath('attention-sidebar-needs-you.png'),
      animations: 'disabled'
    })
  })
})
