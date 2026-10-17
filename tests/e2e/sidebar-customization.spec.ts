import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'

test.beforeEach(async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
})

test('pins a settings page, drags it into another menu, removes it and restores it', async ({
  orcaPage
}, testInfo) => {
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.resetSidebarLayout()
    state.openSettingsTarget({ pane: 'appearance', repoId: null })
    state.openSettingsPage()
  })
  const appearance = orcaPage.locator('[data-settings-section="appearance"]')
  await appearance.getByRole('button', { name: 'Add to sidebar', exact: true }).click()
  await expect(
    appearance.getByRole('button', { name: 'Remove from sidebar', exact: true })
  ).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Back to app', exact: true }).click()
  const agents = orcaPage.locator('[data-nav-group="agents"]')
  if ((await agents.getAttribute('aria-expanded')) !== 'true') {
    await agents.click()
  }
  const pinned = orcaPage.locator('[data-sidebar-row="settings:appearance"]')
  await expect(pinned).toBeVisible()
  await orcaPage.locator('[data-sidebar-customize-trigger]').click()
  await orcaPage.getByRole('checkbox', { name: 'Customize sidebar', exact: true }).check()
  await orcaPage.keyboard.press('Escape')
  await pinned
    .locator('[data-sidebar-drag-handle]')
    .dragTo(orcaPage.locator('[data-nav-group="work"]'))
  await expect(
    orcaPage.locator('[data-sidebar-scope="nav:work"] [data-sidebar-row="settings:appearance"]')
  ).toBeVisible()
  await pinned
    .getByRole('button', { name: 'Hide Appearance from the sidebar', exact: true })
    .click()
  await expect(pinned).toHaveCount(0)
  await orcaPage.locator('[data-sidebar-customize-trigger]').click()
  await orcaPage.getByRole('button', { name: 'Restore Appearance', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(
    orcaPage.locator('[data-sidebar-scope="nav:work"] [data-sidebar-row="settings:appearance"]')
  ).toBeVisible()
  await orcaPage.locator('[data-sidebar-customize-trigger]').click()
  await orcaPage.getByRole('checkbox', { name: 'Customize sidebar', exact: true }).uncheck()
  await orcaPage.keyboard.press('Escape')
  await pinned.getByRole('button', { name: 'Appearance', exact: true }).click()
  await expect(appearance).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('sidebar-settings-pin.png') })
})

test('drags each sidebar out of view and restores its previous width', async ({
  orcaPage
}, testInfo) => {
  await orcaPage.evaluate(() => {
    window.__store!.setState({
      sidebarOpen: true,
      sidebarWidth: 300,
      rightSidebarOpen: true,
      rightSidebarWidth: 320
    })
  })
  for (const [selector, toggle, sign] of [
    ['[data-sidebar-resize-handle]', 'Toggle sidebar', -1],
    ['[data-right-sidebar-resize-handle]', 'Toggle right sidebar', 1]
  ] as const) {
    const handle = orcaPage.locator(selector)
    await expect(handle).toBeVisible()
    const before = await handle.boundingBox()
    if (!before) {
      throw new Error('Sidebar resize handle has no bounds')
    }
    const x = before.x + 2,
      y = before.y + before.height / 2
    await orcaPage.mouse.move(x, y)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(x + sign * 280, y, { steps: 18 })
    await orcaPage.mouse.up()
    await expect(handle).not.toBeVisible()
    await orcaPage.getByRole('button', { name: toggle, exact: true }).click()
    await expect(handle).toBeVisible()
    await expect
      .poll(async () => Math.abs((await handle.boundingBox())!.x - before.x))
      .toBeLessThan(3)
  }
  await orcaPage.screenshot({ path: testInfo.outputPath('sidebars-restored.png') })
})

test('creates a group and moves, removes and restores shortcuts from their menus', async ({
  orcaPage
}, testInfo) => {
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.resetSidebarLayout()
    state.setSidebarCustomizing(false)
    state.openSettingsTarget({ pane: 'appearance', repoId: null })
    state.openSettingsPage()
  })
  await orcaPage
    .locator('[data-settings-section="appearance"]')
    .getByRole('button', { name: 'Add to sidebar', exact: true })
    .click()
  await orcaPage.getByRole('button', { name: 'Back to app', exact: true }).click()
  const agents = orcaPage.locator('[data-nav-group="agents"]')
  if ((await agents.getAttribute('aria-expanded')) !== 'true') {
    await agents.click()
  }
  const pinned = orcaPage.locator('[data-sidebar-row="settings:appearance"]')
  await pinned.getByRole('button', { name: 'Options for Appearance', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'Move to', exact: true }).hover()
  await orcaPage.getByRole('menuitem', { name: 'Work', exact: true }).click()
  const work = orcaPage.locator('[data-nav-group="work"]')
  if ((await work.getAttribute('aria-expanded')) !== 'true') {
    await work.click()
  }
  await expect(
    orcaPage.locator('[data-sidebar-scope="nav:work"] [data-sidebar-row="settings:appearance"]')
  ).toBeVisible()

  await orcaPage.locator('[data-sidebar-customize-trigger]').click()
  await orcaPage.getByRole('textbox', { name: 'Group name', exact: true }).fill('Focus')
  await orcaPage.getByRole('button', { name: 'Create group', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  const custom = orcaPage.locator('[data-nav-group-members^="custom-"]')
  await expect(custom).toContainText('Move shortcuts here')
  await pinned.getByRole('button', { name: 'Options for Appearance', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'Move to', exact: true }).hover()
  await orcaPage.getByRole('menuitem', { name: 'Focus', exact: true }).click()
  await expect(custom.locator('[data-sidebar-row="settings:appearance"]')).toBeVisible()
  await pinned.getByRole('button', { name: 'Options for Appearance', exact: true }).click()
  await orcaPage.screenshot({ path: testInfo.outputPath('sidebar-shortcut-menu.png') })
  await orcaPage.getByRole('menuitem', { name: 'Remove from sidebar', exact: true }).click()
  await expect(pinned).toHaveCount(0)
  await orcaPage.locator('[data-sidebar-customize-trigger]').click()
  await orcaPage.getByRole('button', { name: 'Restore Appearance', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(custom.locator('[data-sidebar-row="settings:appearance"]')).toBeVisible()
  // Persist via the ordinary UI before reloading the renderer.
  await pinned.getByRole('button', { name: 'Appearance', exact: true }).click()
  await expect(orcaPage.locator('[data-settings-section="appearance"]')).toBeVisible()
  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  const back = orcaPage.getByRole('button', { name: 'Back to app', exact: true })
  if (await back.isVisible()) {
    await back.click()
  }
  await expect(custom.locator('[data-sidebar-row="settings:appearance"]')).toBeVisible()
  await orcaPage.locator('[data-sidebar-customize-trigger]').click()
  await orcaPage.getByRole('checkbox', { name: 'Customize sidebar', exact: true }).check()
  await orcaPage.keyboard.press('Escape')
  await pinned.locator('[data-sidebar-drag-handle]').dragTo(agents)
  await expect(
    orcaPage.locator('[data-sidebar-scope="nav:agents"] [data-sidebar-row="settings:appearance"]')
  ).toBeVisible()
  const focusGroup = orcaPage.locator('[data-nav-group^="custom-"]')
  await focusGroup.click()
  await pinned.locator('[data-sidebar-drag-handle]').dragTo(focusGroup)
  await expect(custom.locator('[data-sidebar-row="settings:appearance"]')).toBeVisible()
  await orcaPage.locator('[data-sidebar-customize-trigger]').click()
  await orcaPage.getByRole('checkbox', { name: 'Customize sidebar', exact: true }).uncheck()
  await orcaPage.getByRole('button', { name: 'Delete group Focus', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(custom).toHaveCount(0)
  if ((await agents.getAttribute('aria-expanded')) !== 'true') {
    await agents.click()
  }
  await expect(
    orcaPage.locator('[data-sidebar-scope="nav:agents"] [data-sidebar-row="settings:appearance"]')
  ).toBeVisible()
})
