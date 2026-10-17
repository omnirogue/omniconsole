import { expect, test } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  getGoldenStubStartupScreenEnv,
  launchGoldenStubAgentIntoChat
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContent } from './helpers/terminal'

test.use({ launchEnv: getGoldenStubStartupScreenEnv('codex-update') })

// Why: choosing "Update now" makes Codex update and quit. The conversation must
// stay a conversation: Chat remains reachable and offers the next step.
test('after Update now exits the agent, Chat stays and offers a restart', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await configureGoldenStubAgent(orcaPage, { chatView: true })
  const originalTabId = await launchGoldenStubAgentIntoChat(orcaPage)

  const notice = orcaPage.locator('[data-native-chat-startup-intervention="update-available"]')
  await expect(notice).toBeVisible({ timeout: 20_000 })
  // Seed a launch prompt that never reached the model, as the audited send did.
  await orcaPage.evaluate(() => {
    const store = window.__store!
    const state = store.getState()
    const worktreeId = state.activeWorktreeId!
    const tab = state.tabsByWorktree[worktreeId]?.find((entry) => entry.launchAgent === 'codex')
    state.seedNativeChatLaunchPrompt({
      tabId: tab!.id,
      agent: 'codex',
      text: 'Reply exactly CODEX-UI-AUDIT-READY.',
      createdAt: Date.now()
    })
    state.markNativeChatLaunchPromptFailed(tab!.id)
  })
  await notice.getByRole('button', { name: /Update now/ }).click()
  await expect
    .poll(() => getTerminalContent(orcaPage), { timeout: 15_000 })
    .toContain('GOLDEN_STUB_AGENT_UPDATED_AND_EXITED')

  const exited = orcaPage.locator('[data-native-chat-agent-exited="true"]')
  await expect(exited).toBeVisible({ timeout: 30_000 })
  await expect(exited).toContainText("Codex exited — this conversation's history is kept.")
  await expect(exited).toContainText('carried over as a draft')
  await expect(exited.getByRole('button', { name: 'Start Codex again' })).toBeVisible()
  const toggle = orcaPage
    .locator('[data-conversation-work-header] [data-native-chat-switch]')
    .first()
  await expect(toggle).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('01-agent-exited-chat-kept.png') })
  await exited.getByRole('button', { name: 'Start Codex again' }).click()
  const restartedNotice = orcaPage.locator(
    '[data-native-chat-startup-intervention="update-available"]:visible'
  )
  await expect(restartedNotice).toBeVisible({ timeout: 30_000 })
  await restartedNotice.getByRole('button', { name: 'Skip this time' }).click()
  const restartedChat = orcaPage.locator('[data-native-chat-root="true"]:visible')
  await expect(restartedChat.locator('textarea')).toHaveValue('Reply exactly CODEX-UI-AUDIT-READY.')
  await expect.poll(() => getTerminalContent(orcaPage)).toContain('GOLDEN_STUB_AGENT_READY')
  const recovered = await orcaPage.evaluate((originalTabId) => {
    const state = window.__store!.getState()
    const tabs = state.tabsByWorktree[state.activeWorktreeId!] ?? []
    const next = tabs.find((tab) => tab.launchAgent === 'codex' && tab.id !== originalTabId)
    return {
      id: next?.id,
      mode: state.unifiedTabsByWorktree[state.activeWorktreeId!]?.find(
        (tab) => tab.entityId === next?.id
      )?.viewMode
    }
  }, originalTabId)
  expect(recovered.id).toBeTruthy()
  expect(recovered.mode).toBe('chat')
  await orcaPage.screenshot({ path: testInfo.outputPath('02-agent-restarted-draft-kept.png') })
})
