import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { LOCAL_OLLAMA_MEMORY_ROOT_KEY } from '../../src/shared/local-ollama-launch'

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

test('New thread on a project page offers the inherited context and the project’s agents first', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await openProjects(orcaPage)
  const overview = orcaPage.getByTestId('session-projects-overview')
  await overview.getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name', { exact: true }).fill('Ads')
  await dialog
    .getByLabel('Instructions', { exact: true })
    .fill('Keep every ad under 90 characters.')
  // The project keeps its own copy of the built-in Reviewer; the first agent is its default.
  await dialog.getByRole('button', { name: 'Add agent', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'Reviewer', exact: true }).click()
  await expect(dialog.locator('[data-project-agent="reviewer"]')).toContainText('Default')
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
  const page = orcaPage.getByTestId('session-project-page')
  await expect(page.getByRole('heading', { level: 1, name: 'Ads' })).toBeVisible()

  // Default means the project's first agent, including after explicitly choosing it.
  const instructions = page.getByRole('combobox', { name: 'Agent instructions' })
  await expect(instructions).toContainText('Reviewer')
  await instructions.click()
  await orcaPage.getByRole('option', { name: 'Default', exact: true }).click()
  await expect(instructions).toContainText('Reviewer')

  // A template removed from this computer and the project must show the effective fallback.
  await orcaPage.evaluate(
    (key) =>
      window.__store!.getState().updateSettings({
        launchContextMemory: { [key]: { templateId: 'removed-agent' } }
      }),
    LOCAL_OLLAMA_MEMORY_ROOT_KEY
  )

  // New thread is the folder's own launcher, anchored to the project. A click starts the default
  // provider at once; the arrow key opens the menu, as hovering does, and walks its submenus.
  const trigger = page
    .locator('[data-session-project-new-thread]')
    .getByRole('button', { name: 'New conversation in Ads' })
  await trigger.focus()
  await orcaPage.keyboard.press('ArrowDown')
  const top = orcaPage.getByRole('menu', { name: 'New conversation in Ads' })
  await expect(top.getByRole('menuitem', { name: 'Model' })).toBeFocused()
  await orcaPage.keyboard.press('ArrowRight')
  const projectRow = orcaPage.getByRole('menuitem', { name: /^Project: Ads/ })
  await expect(projectRow).toBeVisible()

  // The project's items are listed, each one tickable, before anything launches.
  await orcaPage.keyboard.press('Home')
  await expect(projectRow).toBeFocused()
  await orcaPage.keyboard.press('ArrowRight')
  const inherited = orcaPage.locator('[data-project-inherited]')
  await expect(inherited).toBeVisible()
  await expect(inherited.locator('[data-project-inherited-item]')).toHaveCount(1)
  await expect(inherited).toContainText('Keep every ad under 90 characters.')
  // Visibility can settle before Radix transfers focus into the newly opened form submenu.
  await orcaPage.getByRole('menu').filter({ has: inherited }).press('ArrowLeft')
  await expect(projectRow).toBeFocused()

  // Customize workspace names the project's agent, and its Agent list puts the project's copies
  // first with the project's default selected; the template they copy is not listed twice.
  const customize = orcaPage.getByRole('menuitem', { name: /^Customize workspace/ })
  await orcaPage.keyboard.type('cu')
  await expect(customize).toBeFocused()
  await expect(customize).toContainText('Reviewer')
  await orcaPage.keyboard.press('ArrowRight')
  const agentRow = orcaPage.getByRole('menuitem', { name: /^Agent: Reviewer/ })
  await orcaPage.keyboard.type('ag')
  await expect(agentRow).toBeFocused()
  await expect(agentRow).toContainText('From the project')
  await orcaPage.keyboard.press('ArrowRight')
  await expect(orcaPage.getByText('From the project', { exact: true })).toBeVisible()
  const reviewer = orcaPage.locator('[data-launcher-agent-row="reviewer"]')
  await expect(reviewer).toHaveCount(1)
  await expect(reviewer).toHaveAttribute('data-launcher-agent-source', 'project')
  await expect(reviewer).toContainText('project')
  await expect(reviewer).toContainText('Selected')
  await expect(orcaPage.locator('[data-launcher-agent-row="developer"]')).toHaveAttribute(
    'data-launcher-agent-source',
    'template'
  )
  await orcaPage.screenshot({
    path: testInfo.outputPath('session-project-new-thread.png'),
    animations: 'disabled'
  })
})
