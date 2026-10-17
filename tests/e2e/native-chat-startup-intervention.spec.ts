import { expect, test } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  getGoldenStubStartupScreenEnv,
  launchGoldenStubAgentIntoChat
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContent } from './helpers/terminal'

// Why: the audited defect — a chat Send reached Codex's startup update menu,
// which ran the updater and exited. The stub draws the captured menu over its
// composer ~0.8 s after start, the window the real send fell into.
test.use({ launchEnv: getGoldenStubStartupScreenEnv('codex-update') })

test('a chat prompt waits for the Codex update menu instead of answering it', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await configureGoldenStubAgent(orcaPage, { chatView: true })
  await launchGoldenStubAgentIntoChat(orcaPage)

  const notice = orcaPage.locator('[data-native-chat-startup-intervention="update-available"]')
  await expect(notice).toBeVisible({ timeout: 20_000 })
  await expect(notice).toContainText('Codex is offering an update (0.153.0 → 0.154.0)')
  // The composer is held: no textarea can feed the menu.
  await expect(orcaPage.locator('[data-native-chat-root="true"] textarea')).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('01-update-menu-held.png') })

  await notice.getByRole('button', { name: 'Skip this time' }).click()
  await expect(notice).toBeHidden({ timeout: 10_000 })
  // Exactly the bytes for "2" then Enter reached the menu — never a pasted prompt.
  await expect
    .poll(() => getTerminalContent(orcaPage), { timeout: 10_000 })
    .toContain('[GOLDEN_STUB_STARTUP_ANSWERED "2" "\\r"]')

  const composer = orcaPage.locator('[data-native-chat-root="true"] textarea').first()
  await expect(composer).toBeVisible({ timeout: 10_000 })
  await composer.fill('UI diagnostic only. Reply exactly CODEX-UI-AUDIT-READY.')
  await composer.press('Enter')
  await expect
    .poll(() => getTerminalContent(orcaPage), { timeout: 15_000 })
    .toContain(
      '[GOLDEN_STUB_AGENT_SUBMITTED] UI diagnostic only. Reply exactly CODEX-UI-AUDIT-READY.'
    )
  await orcaPage.screenshot({ path: testInfo.outputPath('02-prompt-delivered-after-menu.png') })
})
