import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// A fresh profile uses the flat list, with folder and focus views available on demand.
test.use({ seedTestRepo: false, seedFullSidebarLayout: false })

const SESSION_COUNT = 12

test('a fresh profile lists every session and keeps folders and focus optional', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  const sidebar = orcaPage.getByRole('region', { name: 'Sessions' })
  await expect(sidebar).toBeVisible()

  await orcaPage.evaluate(
    ({ folderPath, count }) => {
      const store = window.__store!
      const now = Date.now()
      const leafId = '00000000-0000-4000-8000-000000000001'
      const worktreeId = 'folder:session-focus-fixture'
      const tabs = Array.from({ length: count }, (_, index) => `focus-session-${index}`)
      // Passive, inactive sessions: no agent or workflow is launched by this rendered check.
      store.setState({
        folderWorkspaces: [
          {
            id: 'session-focus-fixture',
            projectGroupId: 'session-focus-project',
            name: 'Focus notes',
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
          [worktreeId]: tabs.map((tabId, index) => ({
            id: tabId,
            worktreeId,
            ptyId: null,
            title: `Focus task ${index}`,
            launchAgent: 'codex',
            customTitle: null,
            color: null,
            sortOrder: index,
            createdAt: now
          }))
        },
        terminalLayoutsByTabId: Object.fromEntries(
          tabs.map((tabId) => [
            tabId,
            { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
          ])
        ),
        sleepingAgentSessionsByPaneKey: Object.fromEntries(
          tabs.map((tabId, index) => {
            const paneKey = `${tabId}:${leafId}`
            return [
              paneKey,
              {
                paneKey,
                tabId,
                worktreeId,
                agent: 'codex',
                providerSession: { key: 'session_id', id: `focus-session-fixture-${index}` },
                prompt: `Focus task ${index}`,
                state: 'done',
                capturedAt: now,
                updatedAt: now,
                origin: 'worktree-sleep',
                restoreOnTabOpenOnly: true
              }
            ]
          })
        )
      })
    },
    { folderPath: testInfo.outputPath('focus-notes'), count: SESSION_COUNT }
  )

  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  const snapshot = await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('[data-session-list-flat="true"]') !== null`,
    returnByValue: true
  })
  expect(snapshot.result.value).toBe(true)
  await cdp.detach()
  await expect(sidebar.locator('[data-session-row]')).toHaveCount(SESSION_COUNT)
  await expect(sidebar.locator('[data-session-focus-line]')).toHaveCount(0)
  await expect(sidebar.locator('[data-session-group] > button')).toHaveCount(0)
  await orcaPage.screenshot({
    path: testInfo.outputPath('flat-sessions.png'),
    animations: 'disabled'
  })

  await sidebar.getByRole('button', { name: 'View: Sessions' }).click()
  await orcaPage.getByRole('menuitemradio', { name: 'Folders', exact: true }).click()
  await expect(orcaPage.getByRole('menu')).toBeHidden()
  await expect(sidebar.locator('[data-session-group]').first()).toBeVisible()
  await sidebar.getByRole('button', { name: 'View: Folders' }).click()
  await orcaPage.getByRole('menuitemradio', { name: 'Focus', exact: true }).click()

  const everythingElse = sidebar.getByRole('button', { name: /^Everything else/ })
  await expect(everythingElse).toBeVisible()
  const lines = sidebar.locator('[data-session-focus-line]')
  expect(await lines.count()).toBeGreaterThan(0)
  expect(await lines.count()).toBeLessThanOrEqual(5)
  await expect(sidebar.locator('[data-session-row]')).toHaveCount(0)
  await orcaPage.screenshot({
    path: testInfo.outputPath('session-focus-view.png'),
    animations: 'disabled'
  })

  await everythingElse.click()
  const back = sidebar.getByRole('button', { name: 'Back to focus view' })
  await expect(back).toBeVisible()
  await expect(lines).toHaveCount(0)
  await expect(sidebar.locator('[data-session-group]').first()).toBeVisible()

  await back.click()
  await expect(everythingElse).toBeVisible()
  await expect(sidebar.locator('[data-session-row]')).toHaveCount(0)
  expect(await lines.count()).toBeLessThanOrEqual(5)
})
