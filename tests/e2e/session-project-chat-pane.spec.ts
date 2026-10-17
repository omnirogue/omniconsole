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

test('the project page shows its chat beside the threads while the chat’s tab is open', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'New folder', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'New folder' }).fill('Ads')
  await orcaPage.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(orcaPage.getByRole('group', { name: 'Ads' })).toBeVisible()

  // A fixture tab stands in for the coordinator's session: no PTY, but a tab the page can borrow.
  const paneKey = await orcaPage.evaluate((folderPath) => {
    const store = window.__store!
    const now = Date.now()
    const worktreeId = 'folder:project-chat-fixture'
    const tabId = 'project-chat-tab'
    const leafId = '00000000-0000-4000-8000-000000000021'
    store.setState({
      folderWorkspaces: [
        {
          id: 'project-chat-fixture',
          projectGroupId: 'project-chat-project',
          name: 'Ads notes',
          folderPath,
          executionHostId: 'local',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now
        }
      ],
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: tabId,
            worktreeId,
            ptyId: null,
            title: 'Project chat',
            launchAgent: 'codex' as const,
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: now
          }
        ]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null
        }
      }
    })
    store.getState().setAgentStatus(
      `${tabId}:${leafId}`,
      {
        state: 'working',
        prompt: 'Coordinate the launch',
        agentType: 'codex',
        lastAssistantMessage: 'Starting the first threads.'
      },
      'Coordinate the launch',
      { updatedAt: now, stateStartedAt: now }
    )
    return `${tabId}:${leafId}`
  }, testInfo.outputPath('ads-notes'))
  await orcaPage.waitForFunction(() => Boolean(window.__sessionFoldersE2E))
  expect(
    await orcaPage.evaluate(
      (key) => window.__sessionFoldersE2E!.moveSessionsToFolder([key], 'Ads'),
      paneKey
    )
  ).toBe(true)
  expect(
    await orcaPage.evaluate(
      (key) => window.__sessionFoldersE2E!.bindProjectChat(key, 'Ads'),
      paneKey
    )
  ).toBe(true)

  await openProjects(orcaPage)
  await orcaPage
    .getByTestId('session-projects-overview')
    .locator('[data-session-project-card]')
    .filter({ hasText: 'Ads' })
    .click()
  const page = orcaPage.getByTestId('session-project-page')
  await expect(page.getByRole('heading', { level: 1, name: 'Ads' })).toBeVisible()
  const pane = page.locator('[data-session-project-chat-pane]')
  await expect(pane).toBeVisible()
  await expect(pane.getByText('Project chat', { exact: true })).toBeVisible()
  await expect(pane.getByText('Codex', { exact: true })).toBeVisible()
  // The thread list marks the same session as the chat, and the header offers to open its tab.
  await expect(page.locator('[data-session-project-chat-mark]')).toBeVisible()
  await expect(page.locator('[data-session-project-chat="open"]')).toBeVisible()
  await orcaPage.screenshot({
    path: testInfo.outputPath('session-project-chat-pane.png'),
    animations: 'disabled'
  })

  // Open in tab leaves the page for the chat's own tab.
  await pane.getByRole('button', { name: 'Open in tab', exact: true }).click()
  await expect(page).toBeHidden()
})
