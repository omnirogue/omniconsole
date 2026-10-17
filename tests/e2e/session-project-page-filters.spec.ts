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

test('status chips and search narrow the project page to the chosen threads', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'New folder', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'New folder' }).fill('Ads')
  await orcaPage.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(orcaPage.getByRole('group', { name: 'Ads' })).toBeVisible()

  // Two passive fixtures: a pane whose agent asked a question, and one whose agent finished
  // while nobody watched (so its work is ready for review).
  const paneKeys = await orcaPage.evaluate((folderPath) => {
    const store = window.__store!
    const now = Date.now()
    const worktreeId = 'folder:project-filter-fixture'
    const asking = {
      tabId: 'project-filter-asking',
      leafId: '00000000-0000-4000-8000-000000000011'
    }
    const done = { tabId: 'project-filter-done', leafId: '00000000-0000-4000-8000-000000000012' }
    const askingPane = `${asking.tabId}:${asking.leafId}`
    const donePane = `${done.tabId}:${done.leafId}`
    const tab = (id: string, title: string, sortOrder: number) => ({
      id,
      worktreeId,
      ptyId: null,
      title,
      launchAgent: 'codex' as const,
      customTitle: null,
      color: null,
      sortOrder,
      createdAt: now
    })
    const layout = (leafId: string) => ({
      root: { type: 'leaf' as const, leafId },
      activeLeafId: leafId,
      expandedLeafId: null
    })
    store.setState({
      folderWorkspaces: [
        {
          id: 'project-filter-fixture',
          projectGroupId: 'project-filter-project',
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
          tab(asking.tabId, 'Pick the launch price', 0),
          tab(done.tabId, 'Write the campaign brief', 1)
        ]
      },
      terminalLayoutsByTabId: {
        [asking.tabId]: layout(asking.leafId),
        [done.tabId]: layout(done.leafId)
      }
    })
    store.getState().setAgentStatus(
      askingPane,
      {
        state: 'blocked',
        prompt: 'Pick the launch price',
        agentType: 'codex',
        lastAssistantMessage: 'Which price should the campaign use?'
      },
      'Pick the launch price',
      { updatedAt: now, stateStartedAt: now }
    )
    store.getState().setAgentStatus(
      donePane,
      {
        state: 'done',
        prompt: 'Write the campaign brief',
        agentType: 'codex',
        lastAssistantMessage: 'The brief is written.'
      },
      'Write the campaign brief',
      { updatedAt: now, stateStartedAt: now }
    )
    return [askingPane, donePane]
  }, testInfo.outputPath('ads-notes'))
  await orcaPage.waitForFunction(() => Boolean(window.__sessionFoldersE2E))
  expect(
    await orcaPage.evaluate(
      (keys) => window.__sessionFoldersE2E!.moveSessionsToFolder(keys, 'Ads'),
      paneKeys
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
  await expect(page.locator('[data-session-project-thread-count="2"]')).toBeVisible()
  const needsYou = page.locator('[data-session-project-group="needsYou"]')
  await expect(needsYou.locator('[data-session-project-group-count="1"]')).toBeVisible()
  await expect(
    needsYou.getByRole('button', { name: 'Open session Pick the launch price' })
  ).toBeVisible()
  const reviewReady = page.locator('[data-session-project-group="reviewReady"]')
  await expect(reviewReady.locator('[data-session-project-group-count="1"]')).toBeVisible()
  await expect(
    reviewReady.getByRole('button', { name: 'Open session Write the campaign brief' })
  ).toBeVisible()
  await orcaPage.screenshot({
    path: testInfo.outputPath('session-project-page-threads.png'),
    animations: 'disabled'
  })

  // A status chip keeps only its bucket.
  const filters = page.locator('[data-session-project-filters]')
  await filters.locator('[data-session-project-filter="status:reviewReady"]').click()
  await expect(page.locator('[data-session-project-thread-count="1"]')).toBeVisible()
  await expect(reviewReady).toBeVisible()
  await expect(needsYou.locator('[data-session-project-group-count="0"]')).toBeVisible()
  await filters.locator('[data-session-project-filter-clear]').click()
  await expect(page.locator('[data-session-project-thread-count="2"]')).toBeVisible()

  // Search matches a row's title.
  await filters.locator('[data-session-project-search]').fill('brief')
  await expect(page.locator('[data-session-project-thread-count="1"]')).toBeVisible()
  await expect(needsYou.locator('[data-session-project-group-count="0"]')).toBeVisible()
  await filters.locator('[data-session-project-search]').fill('')
  await expect(page.locator('[data-session-project-thread-count="2"]')).toBeVisible()

  // The chosen filters are this device's memory for the project.
  await page.getByRole('button', { name: 'All projects', exact: true }).click()
  await orcaPage
    .getByTestId('session-projects-overview')
    .locator('[data-session-project-card]')
    .filter({ hasText: 'Ads' })
    .click()
  await expect(page.locator('[data-session-project-thread-count="2"]')).toBeVisible()
  await filters.locator('[data-session-project-filter="status:needsYou"]').click()
  await expect(page.locator('[data-session-project-thread-count="1"]')).toBeVisible()
  await page.getByRole('button', { name: 'All projects', exact: true }).click()
  await orcaPage
    .getByTestId('session-projects-overview')
    .locator('[data-session-project-card]')
    .filter({ hasText: 'Ads' })
    .click()
  await expect(page.locator('[data-session-project-thread-count="1"]')).toBeVisible()
  await expect(filters.locator('[data-session-project-filter="status:needsYou"]')).toHaveAttribute(
    'data-state',
    'on'
  )
})
