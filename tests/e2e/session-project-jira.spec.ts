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

test('the project page header lists the project’s Jira issues and removes one', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'New folder', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'New folder' }).fill('Launch')
  await orcaPage.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(orcaPage.getByRole('group', { name: 'Launch' })).toBeVisible()

  await orcaPage.waitForFunction(() => Boolean(window.__sessionFoldersE2E))
  const issue = (id: number) => ({
    provider: 'jira' as const,
    cloud_id: 'bb6f9191-a21a-4857-b965-32de82dce68b',
    issue_id: String(id),
    issue_key: `APU-${id}`,
    project_key: 'APU'
  })
  expect(
    await orcaPage.evaluate(
      (tasks) => window.__sessionFoldersE2E!.setProjectTasks('Launch', tasks),
      [issue(101), issue(102)]
    )
  ).toBe(true)

  await openProjects(orcaPage)
  await orcaPage
    .getByTestId('session-projects-overview')
    .locator('[data-session-project-card]')
    .filter({ hasText: 'Launch' })
    .click()
  const page = orcaPage.getByTestId('session-project-page')
  await expect(page.getByRole('heading', { level: 1, name: 'Launch' })).toBeVisible()
  const issues = page.locator('[data-session-project-jira]')
  await expect(issues.locator('[data-session-project-jira-issue="APU-101"]')).toBeVisible()
  await expect(issues.locator('[data-session-project-jira-issue="APU-102"]')).toBeVisible()
  await orcaPage.screenshot({
    path: testInfo.outputPath('session-project-page-jira.png'),
    animations: 'disabled'
  })

  await issues.getByRole('button', { name: 'Remove APU-101 from this project' }).click()
  await expect(issues.locator('[data-session-project-jira-issue="APU-101"]')).toHaveCount(0)
  await expect(page.locator('[data-session-project-jira="1"]')).toBeVisible()

  // The picker is the session Jira dialog, opened for the project.
  await issues.getByRole('button', { name: 'Add issue', exact: true }).click()
  await expect(orcaPage.getByRole('dialog', { name: 'Add to a Jira task' })).toBeVisible()
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.getByRole('dialog', { name: 'Add to a Jira task' })).toHaveCount(0)
})
