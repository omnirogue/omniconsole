import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('normal sidebar session folders persist after reload and preserve their sessions', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await expect(orcaPage.getByRole('region', { name: 'Session folders' })).toBeVisible()
  await orcaPage.screenshot({
    path: testInfo.outputPath('session-folders-before.png'),
    animations: 'disabled'
  })
  await orcaPage.getByRole('button', { name: 'New folder', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'New folder' }).fill('Planning')
  await orcaPage.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(orcaPage.getByRole('group', { name: 'Planning' })).toBeVisible()

  await orcaPage.evaluate((folderPath) => {
    const store = window.__store!
    const now = Date.now()
    const leafId = '00000000-0000-4000-8000-000000000001'
    const tabId = 'folder-session-fixture'
    const paneKey = `${tabId}:${leafId}`
    const worktreeId = 'folder:session-folder-fixture'
    // Passive, inactive session fixture: no agent or workflow is launched by this rendered check.
    store.setState({
      folderWorkspaces: [
        {
          id: 'session-folder-fixture',
          projectGroupId: 'session-folder-project',
          name: 'Research notes',
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
            title: 'Plan the release',
            launchAgent: 'codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: now
          }
        ]
      },
      terminalLayoutsByTabId: {
        [tabId]: { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
      },
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId,
          worktreeId,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'existing-folder-session-fixture' },
          prompt: 'Plan the release',
          state: 'idle',
          capturedAt: now,
          updatedAt: now,
          origin: 'worktree-sleep',
          restoreOnTabOpenOnly: true
        }
      }
    })
  }, testInfo.outputPath('research-notes'))

  const doneGroup = orcaPage.locator('[data-session-group="completed"]')
  await doneGroup.getByRole('button', { name: /^Expand Done/ }).click()
  await expect(
    doneGroup.getByRole('button', { name: 'Open session Plan the release' })
  ).toBeVisible()
  const planningGroup = orcaPage.getByRole('group', { name: 'Planning' })
  // Start on row padding, outside the title button and selection controls.
  await doneGroup.locator('[data-session-row]').dragTo(planningGroup.locator('p'), {
    sourcePosition: { x: 4, y: 4 }
  })
  await expect(
    planningGroup.getByRole('button', { name: 'Open session Plan the release' })
  ).toBeVisible()
  await expect(doneGroup).toHaveCount(0)
  const activeHeader = orcaPage
    .getByRole('button', { name: 'Collapse Active', exact: true })
    .locator('..')
  const headerBox = await activeHeader.boundingBox()
  await planningGroup.locator('[data-session-group-drag-handle]').dragTo(activeHeader, {
    targetPosition: { x: 40, y: headerBox!.height - 2 }
  })
  const order = await orcaPage
    .locator('[data-session-group]')
    .evaluateAll((groups) => groups.map((group) => group.getAttribute('data-session-group')))
  expect(order.indexOf('workspace:other')).toBeLessThan(
    order.findIndex((key) => key?.startsWith('folder:'))
  )

  // Collapse persists on this device too.
  await orcaPage.getByRole('button', { name: 'Collapse Planning' }).click()
  await expect(
    planningGroup.getByRole('button', { name: 'Open session Plan the release' })
  ).toBeHidden()
  await orcaPage.screenshot({
    path: testInfo.outputPath('session-folders-after.png'),
    animations: 'disabled'
  })

  await orcaPage.getByRole('button', { name: 'New saved sessions folder' }).click()
  await orcaPage.getByRole('textbox', { name: 'New folder' }).fill('Saved reports')
  await orcaPage.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(orcaPage.getByRole('group', { name: 'Saved reports', exact: true })).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Expand Planning' }).click()
  await orcaPage.getByRole('checkbox', { name: 'Select Plan the release' }).check()
  await orcaPage.getByRole('button', { name: 'Move to folder (1)' }).click()
  await orcaPage.getByRole('menuitem', { name: 'Saved reports', exact: true }).click()
  await expect(
    orcaPage
      .getByRole('group', { name: 'Saved reports', exact: true })
      .getByRole('button', { name: 'Open session Plan the release' })
  ).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Collapse Planning' }).click()
  await orcaPage.screenshot({
    path: testInfo.outputPath('saved-sessions-folders.png'),
    animations: 'disabled'
  })

  const savedFolders = await orcaPage.evaluate(() =>
    window.localStorage.getItem('omni.session-folders.v1')
  )
  const savedView = await orcaPage.evaluate(() =>
    window.localStorage.getItem('omni.session-sidebar-view.v1')
  )
  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await expect(orcaPage.getByRole('group', { name: 'Planning' })).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Expand Planning' })).toBeVisible()
  expect(
    await orcaPage.evaluate(() => window.localStorage.getItem('omni.session-folders.v1'))
  ).toBe(savedFolders)
  expect(
    await orcaPage.evaluate(() => window.localStorage.getItem('omni.session-sidebar-view.v1'))
  ).toBe(savedView)
})
