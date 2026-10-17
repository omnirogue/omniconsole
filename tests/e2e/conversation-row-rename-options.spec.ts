import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { LABELS, seedConversations } from './helpers/session-bulk-fixture'
import type { Locator, Page } from '@stablyai/playwright-test'

test.use({ seedTestRepo: false })

const WORKTREE = 'folder:bulk-selection-fixture'

function rowFor(page: Page, label: string): Locator {
  return page
    .getByRole('listbox', { name: 'Conversation list' })
    .locator('[data-session-row]')
    .filter({ has: page.getByRole('button', { name: `Open session ${label}`, exact: true }) })
}

async function renameFromPencil(page: Page, from: string, to: string): Promise<void> {
  const row = rowFor(page, from)
  await row.hover()
  const pencil = row.getByRole('button', { name: `Rename ${from}`, exact: true })
  await expect(pencil).toBeVisible()
  await pencil.click()
  const field = page.getByRole('textbox', { name: `Rename ${from}`, exact: true })
  await expect(field).toBeFocused()
  await field.fill(to)
  await field.press('Enter')
  await expect(rowFor(page, to)).toHaveCount(1)
}

test('conversation rows rename in place from the pencil, and New conversation stays in the toolbar', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await seedConversations(orcaPage, testInfo.outputPath('notes'))
  const list = orcaPage.getByRole('listbox', { name: 'Conversation list' })
  await expect(list.getByRole('option')).toHaveCount(LABELS.length)

  // The one new-conversation control lives in the toolbar, never inside a group.
  const newConversation = orcaPage.locator('[data-new-conversation]')
  await expect(newConversation).toHaveCount(1)
  await expect(newConversation).toHaveAccessibleName('New conversation')
  await expect(newConversation.locator('xpath=ancestor::*[@data-session-group]')).toHaveCount(0)

  await rowFor(orcaPage, LABELS[0]).hover()
  // At rest the pencil takes no room from the name; only the hovered row shows it.
  const restingPencil = rowFor(orcaPage, LABELS[2]).getByRole('button', {
    name: `Rename ${LABELS[2]}`,
    exact: true,
    includeHidden: true
  })
  await expect(restingPencil).toHaveCount(1)
  await expect(restingPencil).toBeHidden()
  await orcaPage.screenshot({
    path: testInfo.outputPath('01-hover-pencil.png'),
    animations: 'disabled'
  })
  await renameFromPencil(orcaPage, LABELS[0], 'Ship the release')
  expect(
    await orcaPage.evaluate(
      (worktreeId) =>
        window
          .__store!.getState()
          .tabsByWorktree[worktreeId]?.find((tab) => tab.id === 'bulk-tab-0')?.customTitle,
      WORKTREE
    )
  ).toBe('Ship the release')
  // Esc leaves the name as it was.
  const second = rowFor(orcaPage, LABELS[1])
  await second.hover()
  await second.getByRole('button', { name: `Rename ${LABELS[1]}`, exact: true }).click()
  const field = orcaPage.getByRole('textbox', { name: `Rename ${LABELS[1]}`, exact: true })
  await field.fill('Not this one')
  await orcaPage.screenshot({
    path: testInfo.outputPath('02-rename-field.png'),
    animations: 'disabled'
  })
  await field.press('Escape')
  await expect(rowFor(orcaPage, LABELS[1])).toHaveCount(1)

  // A conversation that finished an hour ago sits under Completed.
  await orcaPage.evaluate((worktreeId) => {
    const store = window.__store!
    const state = store.getState()
    const hourAgo = Date.now() - 60 * 60_000
    const tabId = 'bulk-tab-2'
    const paneKey = `${tabId}:00000000-0000-4000-8000-000000000003`
    const tab = state.tabsByWorktree[worktreeId]!.find((candidate) => candidate.id === tabId)!
    store.setState({
      retainedAgentsByPaneKey: {
        ...state.retainedAgentsByPaneKey,
        [paneKey]: {
          entry: {
            state: 'done',
            prompt: tab.title,
            updatedAt: hourAgo,
            stateStartedAt: hourAgo,
            agentType: 'codex',
            paneKey,
            worktreeId,
            tabId,
            stateHistory: []
          },
          worktreeId,
          tab,
          agentType: 'codex',
          startedAt: hourAgo
        }
      } as never
    })
  }, WORKTREE)
  const completed = orcaPage.locator('[data-session-group-kind="completed"]')
  await expect(completed).toHaveCount(1)
  // A Completed group neither moves nor duplicates the control: one, still in the toolbar.
  await expect(newConversation).toHaveCount(1)
  await expect(newConversation.locator('xpath=ancestor::*[@data-session-group]')).toHaveCount(0)
  await orcaPage.screenshot({
    path: testInfo.outputPath('04-new-conversation-stays-in-toolbar.png'),
    animations: 'disabled'
  })
})
