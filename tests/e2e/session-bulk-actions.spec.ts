import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForStartupWorktreeRefresh } from './helpers/store'
import { LABELS, seedConversations } from './helpers/session-bulk-fixture'
import type { Page } from '@stablyai/playwright-test'

test.use({ seedTestRepo: false })

async function openList(page: Page, folderPath: string, labels: readonly string[] = LABELS) {
  await waitForSessionReady(page)
  // The deferred startup scan can replace a freshly seeded sidebar on slower hosts.
  await waitForStartupWorktreeRefresh(page)
  await page.getByRole('radio', { name: 'Conversations', exact: true }).click()
  // Keep fixture setup visible before any rows have been selected.
  await page.getByRole('button', { name: 'Session timers', exact: true }).click()
  await page
    .locator('[data-slot="dropdown-menu-radio-group"]')
    .filter({ has: page.getByRole('menuitemradio', { name: 'After 3 seconds', exact: true }) })
    .getByRole('menuitemradio', { name: 'Off', exact: true })
    .click()
  await page.keyboard.press('Escape')
  await seedConversations(page, folderPath, labels)
  await page.getByRole('button', { name: /^View:/ }).click()
  await page.getByRole('menuitemradio', { name: 'Folders', exact: true }).click()
  await page.getByRole('button', { name: 'Expand all', exact: true }).click()
  await expect(
    page.getByRole('listbox', { name: 'Conversation list' }).getByRole('option')
  ).toHaveCount(labels.length)
}

async function selectAll(page: Page, count: number) {
  const rows = page.getByRole('listbox', { name: 'Conversation list' }).getByRole('option')
  await rows
    .first()
    .getByRole('button', { name: /^Open session / })
    .click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
  await rows
    .last()
    .getByRole('button', { name: /^Open session / })
    .click({ modifiers: ['Shift'] })
  const bar = page.getByRole('toolbar', { name: 'Selected conversations' })
  await expect(bar).toHaveAttribute('data-session-bulk-bar', String(count))
  await page.getByRole('button', { name: 'Session timers', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'After 3 seconds', exact: true }).click()
  await page.keyboard.press('Escape')
  return bar
}

test('ten mixed-provider rows share range/checkbox selection and can be archived then restored', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const labels = Array.from(
    { length: 10 },
    (_, index) => `Review item ${String(index + 1).padStart(2, '0')}`
  )
  await openList(orcaPage, testInfo.outputPath('notes'), labels)
  const bar = await selectAll(orcaPage, 10)
  await expect(orcaPage.getByRole('checkbox', { checked: true })).toHaveCount(10)
  await bar.hover()
  // Cross the real idle-fold deadline with the pointer outside the selected group.
  await orcaPage.waitForTimeout(4_000)
  await expect(bar).toHaveAttribute('data-session-bulk-bar', '10')
  await expect(orcaPage.getByRole('checkbox', { checked: true })).toHaveCount(10)
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1100, 760)
  })
  for (const width of [220, 320, 500]) {
    await orcaPage.evaluate((next) => window.__store!.getState().setSidebarWidth(next), width)
    await expect(orcaPage.getByRole('toolbar', { name: 'Session bulk actions' })).toHaveCount(0)
    await expect(bar.getByRole('button', { name: 'Archive (10)', exact: true })).toBeVisible()
    await expect.poll(async () => (await bar.boundingBox())?.height ?? 0).toBeLessThanOrEqual(192)
    const list = orcaPage.getByRole('listbox', { name: 'Conversation list' })
    await expect.poll(async () => (await list.boundingBox())?.height ?? 0).toBeGreaterThan(100)
    await orcaPage.screenshot({ path: testInfo.outputPath(`selected-width-${width}.png`) })
  }
  await orcaPage.getByRole('button', { name: /^View:/ }).click()
  await orcaPage.getByRole('menuitemradio', { name: 'Sessions', exact: true }).click()
  await expect(orcaPage.locator('[data-session-list-flat]')).toBeVisible()
  await expect(bar).toHaveAttribute('data-session-bulk-bar', '10')
  await expect(orcaPage.getByRole('checkbox', { checked: true })).toHaveCount(10)
  await orcaPage.screenshot({ path: testInfo.outputPath('selected-flat.png') })
  await orcaPage.screenshot({ path: testInfo.outputPath('01-ten-selected.png') })
  await bar.getByRole('button', { name: 'Archive (10)', exact: true }).click()
  await orcaPage.getByRole('button', { name: /^View:/ }).click()
  await orcaPage.getByRole('menuitemradio', { name: 'Folders', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Show archived (10)', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Expand Archived (10)', exact: true }).click()
  const archived = orcaPage.getByRole('group', { name: 'Archived (10)', exact: true })
  await expect(archived.getByRole('option')).toHaveCount(10)
  // Why: 3552fad103 deleted ConversationOptionsMenu ("Organize conversation"); unarchiving is
  // now the row's own quick action, labelled by ConversationArchiveButton.tsx:17.
  await archived.getByRole('option').first().hover()
  const unarchive = archived.getByRole('button', { name: `Unarchive ${labels[0]}`, exact: true })
  await unarchive.focus()
  await unarchive.press('Enter')
  await expect(orcaPage.getByRole('group', { name: 'Archived (9)', exact: true })).toBeVisible()
  await expect(
    orcaPage.getByRole('button', { name: `Open session ${labels[0]}`, exact: true })
  ).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('02-archive-restore.png') })
})

test('bulk Move to folder organizes conversations without moving their files', async ({
  orcaPage
}, testInfo) => {
  const folderPath = testInfo.outputPath('source-notes')
  mkdirSync(folderPath, { recursive: true })
  const file = path.join(folderPath, 'note.txt')
  writeFileSync(file, 'Source files stay here.\n')
  await openList(orcaPage, folderPath)
  await orcaPage.getByRole('button', { name: 'New folder', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'New folder', exact: true }).fill('Planning')
  await orcaPage.getByRole('button', { name: 'Create', exact: true }).click()
  const bar = await selectAll(orcaPage, 3)
  await bar.locator('[data-session-bulk-action="move"]').click()
  await orcaPage.getByRole('menuitem', { name: 'Planning', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Expand Planning', exact: true }).click()
  const planning = orcaPage.getByRole('group', { name: 'Planning', exact: true })
  for (const label of LABELS) {
    await expect(
      planning.getByRole('button', { name: `Open session ${label}`, exact: true })
    ).toBeVisible()
  }
  expect(readFileSync(file, 'utf8')).toBe('Source files stay here.\n')
  await expect(bar).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('03-moved-to-folder.png') })
})

test('bulk Delete closes the selected passive conversations', async ({ orcaPage }, testInfo) => {
  await openList(orcaPage, testInfo.outputPath('notes'))
  const bar = await selectAll(orcaPage, 3)
  await bar.getByRole('button', { name: 'Delete (3)', exact: true }).click()
  for (const label of LABELS) {
    await expect(
      orcaPage.getByRole('button', { name: `Open session ${label}`, exact: true })
    ).toHaveCount(0)
  }
  await expect(bar).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('04-closed.png') })
})

test('Send to human opens a sequenced panel; skipping and stopping preserve unsent selections', async ({
  orcaPage
}, testInfo) => {
  await openList(orcaPage, testInfo.outputPath('notes'))
  const bar = await selectAll(orcaPage, 3)
  // Why Send to human only: since cd2f148026 Dispatch is one batch form for the whole
  // selection, opened from the bar's More options — not a per-conversation sequence.
  // SessionBulkActionBar.test.tsx:258 and tests/e2e/fleet-dispatch-ui.spec.ts cover it.
  await bar.locator('[data-session-bulk-action="send-to-human"]').click()
  const panel = orcaPage.locator('[data-session-bulk-next-step]')
  await expect(panel).toContainText('1 of 3')
  await panel.getByRole('button', { name: 'Skip this one', exact: true }).click()
  await expect(panel).toContainText('2 of 3')
  await orcaPage.screenshot({ path: testInfo.outputPath('05-send-to-human-panel.png') })
  await panel.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect(bar).toHaveAttribute('data-session-bulk-bar', '3')
})
