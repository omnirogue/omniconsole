import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

import { LABELS, seedConversations } from './helpers/session-bulk-fixture'

test('Shift+Down extends a selection across mixed Codex/Claude rows and bulk Hide keeps open rows listed', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await expect(orcaPage.getByRole('region', { name: 'Session folders' })).toBeVisible()
  await seedConversations(orcaPage, testInfo.outputPath('bulk-notes'))
  // Why: the seeded rows land in Done, and idle groups fold after 5 s (#589) — turn folding off
  // and open every group so the rows stay on screen for the whole check.
  await orcaPage.getByRole('button', { name: /^Idle groups fold/ }).click()
  await orcaPage.getByRole('menuitemradio', { name: 'Off' }).click()
  await orcaPage.keyboard.press('Escape')
  await orcaPage.getByRole('button', { name: 'Expand all' }).click()

  const list = orcaPage.getByRole('listbox', { name: 'Conversation list' })
  await expect(list).toBeVisible()
  for (const label of LABELS) {
    await expect(orcaPage.getByRole('button', { name: `Open session ${label}` })).toBeVisible()
  }

  // Cmd/Ctrl+click toggles without opening; the row becomes the range anchor.
  // Why the rendered order: rows sort by attention and label, not by seeding order.
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  const rows = list.getByRole('option')
  await expect(rows).toHaveCount(3)
  await rows
    .first()
    .getByRole('button', { name: /^Open session / })
    .click({ modifiers: [modifier] })
  const bar = orcaPage.getByRole('toolbar', { name: 'Selected conversations' })
  await expect(bar).toBeVisible()
  await expect(bar).toHaveAttribute('data-session-bulk-bar', '1')

  await orcaPage.keyboard.press('Shift+ArrowDown')
  await orcaPage.keyboard.press('Shift+ArrowDown')
  await expect(bar).toHaveAttribute('data-session-bulk-bar', '3')
  await expect(orcaPage.locator('[role="option"][aria-selected="true"]')).toHaveCount(3)

  // Reversing direction shrinks toward the anchor.
  await orcaPage.keyboard.press('Shift+ArrowUp')
  await expect(bar).toHaveAttribute('data-session-bulk-bar', '2')
  await orcaPage.keyboard.press('Shift+ArrowDown')
  await expect(bar).toHaveAttribute('data-session-bulk-bar', '3')
  await orcaPage.screenshot({
    path: testInfo.outputPath('01-three-selected.png'),
    animations: 'disabled'
  })

  await bar.locator('[data-session-bulk-action="hide"]').click()
  // Why (Sal, 2026-09-23): a conversation whose tab is open is always listed. The hide mark is
  // kept and takes each row to Hidden once its tab is closed; until then its eye shows it hidden.
  await expect(orcaPage.getByRole('button', { name: /^Expand Hidden/ })).toHaveCount(0)
  for (const label of LABELS) {
    await expect(orcaPage.getByRole('button', { name: `Open session ${label}` })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: `Show ${label}` })).toHaveCount(1)
  }
  // Hiding is personal organization: every checkpoint is still in the store.
  expect(
    await orcaPage.evaluate(
      () => Object.keys(window.__store!.getState().sleepingAgentSessionsByPaneKey).length
    )
  ).toBe(3)
  await orcaPage.screenshot({
    path: testInfo.outputPath('02-hidden-while-open.png'),
    animations: 'disabled'
  })
})
