import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

/** The Projects entry lives inside the Work group, which starts closed. */
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

test('creates a project from the overview and lands on its page', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await openProjects(orcaPage)
  const overview = orcaPage.getByTestId('session-projects-overview')
  await expect(overview).toBeVisible()
  await expect(overview.getByText('No projects yet')).toBeVisible()

  await overview.getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog', { name: 'New project' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Name', { exact: true }).fill('Checkout rewrite')
  await dialog.getByLabel('Instructions', { exact: true }).fill('Ship the new checkout flow.')
  // The project chat: the launcher's default provider as a team, changed here to Codex.
  const runBy = dialog.getByRole('combobox', { name: 'Run by', exact: true })
  await expect(runBy).toContainText('Claude')
  await expect(dialog.getByRole('checkbox', { name: 'As a team' })).toBeChecked()
  await runBy.click()
  await orcaPage.getByRole('option', { name: 'Codex', exact: true }).click()
  await expect(runBy).toContainText('Codex')
  // Its model and effort, as the launcher's own pickers offer them.
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).click()
  await orcaPage.getByRole('option', { name: 'GPT-5.5', exact: true }).click()
  await dialog.getByRole('combobox', { name: 'Effort', exact: true }).click()
  await orcaPage.getByRole('option', { name: 'High', exact: true }).click()
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()

  const page = orcaPage.getByTestId('session-project-page')
  await expect(page).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Checkout rewrite' })).toBeVisible()
  // The instructions became the project's first attachment.
  await expect(page.getByRole('region', { name: 'Project context' })).toContainText('Instructions')
  await expect(page.getByTestId('session-project-dispatch')).toBeVisible()
  await expect(page.locator('[data-session-project-new-thread]')).toBeVisible()
  // The chat has not started, so the page offers to start it with the saved pick.
  await expect(page.getByRole('button', { name: 'Start coordinator', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Project settings…', exact: true }).click()
  const settings = orcaPage.getByRole('dialog', { name: /^Project settings/ })
  await expect(settings.getByRole('combobox', { name: 'Run by', exact: true })).toContainText(
    'Codex'
  )
  await expect(settings.getByRole('checkbox', { name: 'As a team' })).toBeChecked()
  await expect(settings.getByRole('combobox', { name: 'Model', exact: true })).toContainText(
    'GPT-5.5'
  )
  await expect(settings.getByRole('combobox', { name: 'Effort', exact: true })).toContainText(
    'High'
  )
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(settings).toBeHidden()
  await orcaPage.screenshot({
    path: testInfo.outputPath('session-project-created.png'),
    animations: 'disabled'
  })

  // The project is a session folder, so Conversations lists it as one.
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await expect(orcaPage.getByRole('group', { name: 'Checkout rewrite' })).toBeVisible()
})

test('the project chat can run on Local Ollama', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await openProjects(orcaPage)
  const overview = orcaPage.getByTestId('session-projects-overview')
  await overview.getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name', { exact: true }).fill('Local research')
  const runBy = dialog.getByRole('combobox', { name: 'Run by', exact: true })
  await runBy.click()
  await orcaPage.getByRole('option', { name: 'Local Ollama', exact: true }).click()
  await expect(runBy).toContainText('Local Ollama')
  // Local Ollama replaces the provider's model and effort with this computer's Ollama models.
  const ollama = dialog.locator('[data-project-settings-coordinator-ollama]')
  await expect(ollama).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'Effort', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('checkbox', { name: 'As a team' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()

  const page = orcaPage.getByTestId('session-project-page')
  await expect(page.getByRole('heading', { level: 1, name: 'Local research' })).toBeVisible()
  await page.getByRole('button', { name: 'Project settings…', exact: true }).click()
  const settings = orcaPage.getByRole('dialog', { name: /^Project settings/ })
  await expect(settings.getByRole('combobox', { name: 'Run by', exact: true })).toContainText(
    'Local Ollama'
  )
})

test('Start coordinator shows what the project chat gets before it starts', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await openProjects(orcaPage)
  const overview = orcaPage.getByTestId('session-projects-overview')
  await overview.getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name', { exact: true }).fill('Chat review')
  await dialog.getByLabel('Instructions', { exact: true }).fill('Keep threads small.')
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()

  const page = orcaPage.getByTestId('session-project-page')
  await page.getByRole('button', { name: 'Start coordinator', exact: true }).click()
  const review = orcaPage.getByRole('dialog', { name: 'What this session gets' })
  await expect(review).toBeVisible()
  await expect(review).toContainText('Coordinator')
  await expect(review).toContainText('Keep threads small.')
  await review.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(review).toBeHidden()
})
