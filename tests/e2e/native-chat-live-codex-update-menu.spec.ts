import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContent } from './helpers/terminal'

/**
 * Live check against the REAL Codex CLI. Opt-in only: it needs a logged-in
 * `~/.codex` on the host and a Codex binary that offers the update menu.
 *
 *   OMNI_LIVE_CODEX=/Users/me/.local/node/bin/codex pnpm exec playwright test tests/e2e/native-chat-live-codex-update-menu.spec.ts ...
 *
 * The host's `~/.codex` is never touched: auth/config are copied into a
 * temporary CODEX_HOME that the launched Codex reads through the agent env.
 */
const LIVE_CODEX = process.env.OMNI_LIVE_CODEX ?? ''
const PROMPT =
  'UI diagnostic only. Reply exactly CODEX-UI-AUDIT-READY. Do not use tools or change files.'

test.skip(!LIVE_CODEX, 'set OMNI_LIVE_CODEX=<absolute codex path> to run the live Codex check')
test.use({ launchEnv: { PATH: `${path.dirname(LIVE_CODEX)}:${process.env.PATH ?? ''}` } })

test('real Codex: the update menu is held, answered, and the prompt is delivered', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  // Why $HOME/.codex: the app's Codex launch preparation pins the pane's CODEX_HOME to the
  // "real-home" route ($HOME/.codex) when no managed account is selected, so a free temp dir
  // would be ignored. The harness HOME is disposable and removed after the test.
  const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
  if (isolatedHome === os.homedir()) {
    throw new Error('refusing to seed credentials into the developer home')
  }
  const codexHome = path.join(isolatedHome, '.codex')
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  for (const name of [
    'auth.json',
    'config.toml',
    'hooks.json',
    'installation_id',
    'version.json'
  ]) {
    const source = path.join(os.homedir(), '.codex', name)
    if (existsSync(source)) {
      copyFileSync(source, path.join(codexHome, name))
    }
  }
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.evaluate(
      async ({ codexPath, codexHome }) => {
        const store = window.__store!
        await store.getState().updateSettings({
          defaultTuiAgent: 'codex',
          agentCmdOverrides: { codex: codexPath },
          agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' },
          agentDefaultEnv: { codex: { CODEX_HOME: codexHome } },
          experimentalNativeChat: true,
          openAgentTabsInChatByDefault: true
        })
      },
      { codexPath: LIVE_CODEX, codexHome }
    )
    const tabId = await orcaPage.evaluate(
      ({ codexPath, codexHome }) => {
        const state = window.__store!.getState()
        const worktreeId = state.activeWorktreeId!
        const tab = state.createTab(worktreeId, undefined, undefined, {
          launchAgent: 'codex',
          viewMode: 'chat',
          pendingStartup: {
            command: `${codexPath} --dangerously-bypass-approvals-and-sandbox`,
            env: { CODEX_HOME: codexHome },
            launchAgent: 'codex',
            startupCommandDelivery: 'shell-ready'
          }
        } as never)
        state.setActiveTabType('terminal')
        return tab.id
      },
      { codexPath: LIVE_CODEX, codexHome }
    )
    test.info().annotations.push({ type: 'tab', description: tabId })
    await expect(orcaPage.locator('[data-native-chat-root="true"]').first()).toBeVisible({
      timeout: 60_000
    })

    const notice = orcaPage.locator('[data-native-chat-startup-intervention]')
    await expect(notice.first()).toBeVisible({ timeout: 90_000 })
    const kind = await notice.first().getAttribute('data-native-chat-startup-intervention')
    test.info().annotations.push({ type: 'intervention', description: kind ?? 'none' })
    await orcaPage.screenshot({ path: testInfo.outputPath('01-live-intervention.png') })
    const noticeText = await notice.first().innerText()
    test.info().annotations.push({ type: 'notice', description: noticeText.replace(/\n/g, ' | ') })
    await expect(orcaPage.locator('[data-native-chat-root="true"] textarea')).toHaveCount(0)
    expect(kind).toBe('update-available')
    expect(noticeText).toContain('Codex is offering an update')

    await notice.first().getByRole('button', { name: 'Skip this time' }).click()
    await expect(notice.first()).toBeHidden({ timeout: 30_000 })
    const composer = orcaPage.locator('[data-native-chat-root="true"] textarea').first()
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await orcaPage.screenshot({ path: testInfo.outputPath('02-live-composer-back.png') })

    await composer.fill(PROMPT)
    await composer.press('Enter')
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 240_000, intervals: [2_000] })
      .toMatch(/CODEX-UI-AUDIT-READY[\s\S]*CODEX-UI-AUDIT-READY/)
    await orcaPage.waitForTimeout(3_000)
    await orcaPage.screenshot({ path: testInfo.outputPath('03-live-answered.png') })
    const chatText = await orcaPage.locator('[data-native-chat-root="true"]').first().innerText()
    test.info().annotations.push({
      type: 'chat-text',
      description: chatText.replace(/\n/g, ' | ').slice(0, 2000)
    })
    const terminal = await getTerminalContent(orcaPage)
    // Exactly one turn: the prompt appears once as the user turn; the model's echo is the reply.
    expect((terminal.match(/UI diagnostic only\./g) ?? []).length).toBeLessThanOrEqual(2)
  } finally {
    rmSync(codexHome, { recursive: true, force: true })
  }
})
