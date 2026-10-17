import { expect, test } from './helpers/orca-app'

test.use({ dismissOnboarding: false, seedTestRepo: false })
test.skip(process.platform !== 'win32', 'Fresh-profile fsync regression is Windows-only')

test('fresh Windows profile reaches onboarding @windows-fresh-startup-golden', async ({
  orcaPage
}) => {
  await expect(
    orcaPage.getByRole('heading', { name: /Create or Connect your OmniRogue Account/i })
  ).toBeVisible({
    timeout: 30_000
  })
})
