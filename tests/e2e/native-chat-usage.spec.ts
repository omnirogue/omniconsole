import { test, expect } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  launchGoldenStubAgentIntoChat
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

test('chat usage follows Codex, discloses other balances on hover, and fits narrow panes', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await configureGoldenStubAgent(orcaPage, { agent: 'codex', chatView: true })
  await launchGoldenStubAgentIntoChat(orcaPage, 'codex')
  await orcaPage.evaluate(() => {
    const store = window.__store!
    const rateLimits = store.getState().rateLimits
    const quotaWindow = (usedPercent: number) => ({
      usedPercent,
      windowMinutes: 10_080,
      resetsAt: Date.now() + 7 * 86_400_000,
      resetDescription: null
    })
    const snapshot = (provider: 'claude' | 'codex', usedPercent: number) => ({
      provider,
      status: 'ok' as const,
      error: null,
      updatedAt: Date.now(),
      session: null,
      weekly: quotaWindow(usedPercent)
    })
    store.setState({
      // Keep fixture balances stable while the isolated, credential-free host finishes hydration.
      setRateLimitsFromPush: () => {},
      detectedAgentIds: ['claude', 'codex'],
      usagePercentageDisplay: 'used',
      rateLimits: {
        ...rateLimits,
        claude: snapshot('claude', 94),
        codex: snapshot('codex', 2)
      }
    })
  })
  const chat = orcaPage.locator('[data-native-chat-root="true"]').first()
  const usage = chat.getByRole('button', { name: 'Usage · Codex · 2% used' })
  const panel = orcaPage.locator('[data-chat-usage-panel]')
  const composer = chat.locator('textarea')
  await expect(usage).toBeVisible()
  await expect(usage).toHaveText('Codex · 2% used')
  await expect(usage).toHaveAttribute('data-chat-usage-level', 'fine')
  await expect(panel).toBeHidden()
  await composer.fill('Keep this draft while checking usage')
  await usage.hover()
  await expect(panel).toBeVisible()
  await expect(composer).toBeFocused()
  await expect(panel.locator('li').first()).toHaveAttribute('data-chat-usage-provider', 'codex')
  await expect(panel.locator('[data-chat-usage-provider="claude"]')).toContainText('94%')
  await expect(panel).not.toContainText('Resets Resets')
  await orcaPage.screenshot({ path: testInfo.outputPath('codex-usage-hover.png') })

  await panel.hover()
  await expect(panel).toBeVisible()
  await orcaPage.mouse.move(0, 0)
  await expect(panel).toBeHidden()
  await expect(composer).toHaveValue('Keep this draft while checking usage')
  await usage.focus()
  await usage.press('Enter')
  await expect(panel.getByRole('button', { name: 'Refresh usage' })).toBeFocused()
  await orcaPage.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(usage).toBeFocused()

  // A split pane can be narrow even on a large desktop display.
  for (const theme of ['light', 'dark'] as const) {
    await orcaPage.evaluate(async (theme) => {
      await window.__store!.getState().updateSettingsOrThrow({ theme })
    }, theme)
    await chat.evaluate((element) => {
      element.style.width = '320px'
      element.style.maxWidth = '320px'
    })
    await expect(usage).toBeVisible()
    const send = chat.getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeVisible()
    await expect
      .poll(async () => {
        const pane = await chat.boundingBox()
        const button = await send.boundingBox()
        return Boolean(
          pane && button && button.x >= pane.x && button.x + button.width <= pane.x + pane.width
        )
      })
      .toBe(true)
    await orcaPage.screenshot({ path: testInfo.outputPath(`chat-narrow-${theme}.png`) })
  }
})
