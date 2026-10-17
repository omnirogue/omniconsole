import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('the sidebar offers Conversations · Sessions · Developer Workspaces and switches between them', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const view = orcaPage.getByRole('radiogroup', { name: 'Sidebar view' })
  await expect(view.getByRole('radio', { name: 'Conversations', exact: true })).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Sessions', exact: true })).toBeVisible()
  await expect(view.getByRole('radio', { name: 'Companies', exact: true })).toHaveCount(0)

  const wrench = orcaPage.getByRole('button', { name: 'Developer Workspaces' })
  await expect(wrench).toBeVisible()
  await expect(view.getByRole('radio', { name: 'Workspaces', exact: true })).toHaveCount(0)

  await view.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await expect(orcaPage.getByRole('region', { name: 'Session folders' })).toBeVisible()

  await orcaPage.getByRole('button', { name: 'Sessions', exact: true }).click()
  // 6846ee0b1f unified the two views into one SessionSidebar, so the technical surface is the
  // same 'Session folders' region read technically; the switch shows on the Sessions button.
  await expect(orcaPage.getByRole('button', { name: 'Sessions', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(orcaPage.getByRole('region', { name: 'Session folders' })).toBeVisible()

  await wrench.click()
  await expect(orcaPage.getByRole('region', { name: 'Session folders' })).toHaveCount(0)
  await expect(orcaPage.getByRole('button', { name: 'Sessions', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
})
