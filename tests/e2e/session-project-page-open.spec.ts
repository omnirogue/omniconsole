import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

async function openProjects(page: Page): Promise<void> {
  const entry = page.locator('[data-sidebar-projects-entry]')
  if ((await entry.count()) === 0) {
    await page
      .getByRole('button', { name: /^Work(?:\s|$)/ })
      .first()
      .click()
    await entry.waitFor({ timeout: 10_000 })
  }
  await entry.click()
}

test('opens a folder as a project from the overview, the sidebar heading, and back', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await expect(orcaPage.getByRole('region', { name: 'Session folders' })).toBeVisible()
  await orcaPage.getByRole('button', { name: 'New folder', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'New folder' }).fill('Planning')
  await orcaPage.getByRole('button', { name: 'Create', exact: true }).click()
  const planningGroup = orcaPage.getByRole('group', { name: 'Planning' })
  await expect(planningGroup).toBeVisible()

  // Every top-level folder is a project, set up or not.
  await openProjects(orcaPage)
  const overview = orcaPage.getByTestId('session-projects-overview')
  await expect(overview).toBeVisible()
  const card = overview.locator('[data-session-project-card]').filter({ hasText: 'Planning' })
  await expect(card).toBeVisible()
  await expect(card).toContainText('Not set up')
  await card.click()

  const page = orcaPage.getByTestId('session-project-page')
  await expect(page).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Planning' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Set up', exact: true })).toBeVisible()
  await expect(page.getByText('No threads yet')).toBeVisible()
  // The Library lists what the threads produced; a new project has nothing yet.
  await expect(page.getByRole('region', { name: 'Library' })).toContainText('Library 0')
  await orcaPage.screenshot({
    path: testInfo.outputPath('session-project-page.png'),
    animations: 'disabled'
  })

  await page.getByRole('button', { name: 'All projects', exact: true }).click()
  await expect(overview).toBeVisible()

  // The folder heading in Conversations opens the same page.
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await planningGroup.hover()
  await orcaPage.getByRole('button', { name: 'Open project Planning', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Planning' })).toBeVisible()
})
