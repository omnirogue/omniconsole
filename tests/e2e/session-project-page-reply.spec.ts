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

test('a waiting thread is answered and followed up from the project page', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'New folder', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'New folder' }).fill('Pricing')
  await orcaPage.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(orcaPage.getByRole('group', { name: 'Pricing' })).toBeVisible()

  // A passive fixture: a pane whose agent asked a question with options. Its pty id is not a
  // live terminal, so a follow-up is refused visibly instead of typed anywhere.
  const paneKey = await orcaPage.evaluate((folderPath) => {
    const store = window.__store!
    const now = Date.now()
    const worktreeId = 'folder:project-reply-fixture'
    const tabId = 'project-reply-asking'
    const leafId = '00000000-0000-4000-8000-000000000021'
    const pane = `${tabId}:${leafId}`
    store.setState({
      folderWorkspaces: [
        {
          id: 'project-reply-fixture',
          projectGroupId: 'project-reply-project',
          name: 'Pricing notes',
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
            ptyId: 'project-reply-pty',
            title: 'Pick the launch price',
            launchAgent: 'claude' as const,
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
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'project-reply-pty' }
        }
      }
    })
    store.getState().setAgentStatus(
      pane,
      {
        state: 'waiting',
        prompt: 'Pick the launch price',
        agentType: 'claude',
        toolName: 'AskUserQuestion',
        interactivePrompt: JSON.stringify({
          questions: [
            {
              question: 'Which launch price?',
              multiSelect: false,
              options: [{ label: '$29' }, { label: '$49' }]
            }
          ]
        })
      },
      'Pick the launch price',
      { updatedAt: now, stateStartedAt: now }
    )
    return pane
  }, testInfo.outputPath('pricing-notes'))
  await orcaPage.waitForFunction(() => Boolean(window.__sessionFoldersE2E))
  expect(
    await orcaPage.evaluate(
      (keys) => window.__sessionFoldersE2E!.moveSessionsToFolder(keys, 'Pricing'),
      [paneKey]
    )
  ).toBe(true)

  await openProjects(orcaPage)
  await orcaPage
    .getByTestId('session-projects-overview')
    .locator('[data-session-project-card]')
    .filter({ hasText: 'Pricing' })
    .click()
  const page = orcaPage.getByTestId('session-project-page')
  await expect(page.getByRole('heading', { level: 1, name: 'Pricing' })).toBeVisible()
  const row = page.locator('[data-session-project-group="needsYou"] [data-session-project-thread]')
  await expect(row).toHaveCount(1)

  // The question and its options sit under the thread's row.
  const question = row.locator(`[data-needs-you-question="${paneKey}"]`)
  await expect(question).toContainText('Which launch price?')
  await expect(question.getByRole('button', { name: '$49' })).toBeVisible()

  // A follow-up is written in place; a thread whose terminal is gone says so and keeps the draft.
  await row.getByRole('button', { name: 'Reply', exact: true }).click()
  const reply = row.locator('[data-session-project-reply]')
  const field = reply.getByRole('textbox', {
    name: 'Reply to Pick the launch price'
  })
  await field.fill('Go with the cheaper plan')
  await orcaPage.screenshot({
    path: testInfo.outputPath('session-project-page-reply.png'),
    animations: 'disabled'
  })
  await reply.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(reply.getByRole('alert')).toContainText('no longer available')
  await expect(field).toHaveValue('Go with the cheaper plan')
  await reply.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(field).toHaveCount(0)
})
