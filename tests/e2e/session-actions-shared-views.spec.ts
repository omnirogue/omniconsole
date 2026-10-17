import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('Sessions and Conversations share selection, actions and folder organization', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('button', { name: 'Sessions', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'New folder', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'New folder' }).fill('Planning')
  await orcaPage.getByRole('button', { name: 'Create', exact: true }).click()
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
          state: 'done',
          capturedAt: now,
          updatedAt: now,
          origin: 'worktree-sleep',
          restoreOnTabOpenOnly: true
        }
      }
    })
    const state = store.getState()
    const secondTabId = 'folder-session-fixture-two'
    const secondPaneKey = `${secondTabId}:${leafId}`
    store.setState({
      tabsByWorktree: {
        [worktreeId]: [
          ...state.tabsByWorktree[worktreeId]!,
          {
            ...state.tabsByWorktree[worktreeId]![0]!,
            id: secondTabId,
            title: 'Check release notes'
          }
        ]
      },
      terminalLayoutsByTabId: {
        ...state.terminalLayoutsByTabId,
        [secondTabId]: state.terminalLayoutsByTabId[tabId]!
      },
      sleepingAgentSessionsByPaneKey: {
        ...state.sleepingAgentSessionsByPaneKey,
        [secondPaneKey]: {
          ...state.sleepingAgentSessionsByPaneKey[paneKey]!,
          paneKey: secondPaneKey,
          tabId: secondTabId,
          prompt: 'Check release notes',
          providerSession: { key: 'session_id', id: 'second-folder-session-fixture' }
        }
      }
    })
  }, testInfo.outputPath('research-notes'))

  const row = orcaPage
    .locator('[data-session-row]')
    .filter({ has: orcaPage.getByRole('button', { name: 'Open session Plan the release' }) })
    .first()
  await expect(row).toContainText('This device')
  await row.hover()
  await row.getByRole('button', { name: 'Add next after Plan the release' }).click()
  await orcaPage.getByRole('menuitem', { name: 'Select sessions · bulk actions' }).click()
  await orcaPage.getByRole('button', { name: 'Select matching' }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.getByText('2 sessions selected', { exact: true })).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Unselect all' })).toBeVisible()
  await expect(orcaPage.getByRole('toolbar', { name: 'Session bulk actions' })).toBeVisible()
  await orcaPage.screenshot({
    path: testInfo.outputPath('session-bulk-menu.png'),
    animations: 'disabled'
  })
  await orcaPage.getByRole('button', { name: 'More actions', exact: true }).click()
  await orcaPage.getByRole('combobox', { name: 'Move to folder' }).click()
  await orcaPage.getByRole('option', { name: 'Planning', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(
    orcaPage
      .getByRole('group', { name: 'Planning', exact: true })
      .getByRole('button', { name: 'Open session Plan the release' })
  ).toBeVisible()
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  const planning = orcaPage.getByRole('group', { name: 'Planning', exact: true })
  await expect(
    planning.getByRole('button', { name: 'Open session Plan the release' })
  ).toBeVisible()
  await expect(planning.getByRole('checkbox', { name: 'Select Plan the release' })).toBeChecked()
  await expect(
    planning.getByRole('button', { name: 'Open session Check release notes' })
  ).toBeVisible()
  await expect(planning.getByRole('checkbox', { name: 'Select Check release notes' })).toBeChecked()
  await orcaPage.getByRole('button', { name: 'Snooze', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Snooze selected' }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.locator('[data-session-group-kind="waiting"]')).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Snooze', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Bring back now', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(
    planning.getByRole('button', { name: 'Open session Plan the release' })
  ).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Hide', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(planning.getByRole('button', { name: 'Open session Plan the release' })).toHaveCount(
    0
  )
  await orcaPage.getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(planning.getByRole('button', { name: 'Open session Plan the release' })).toHaveCount(
    0
  )
  await expect(orcaPage.locator('[data-session-group-kind="hidden"]')).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Unselect all' }).click()
  await expect(orcaPage.getByRole('toolbar', { name: 'Session bulk actions' })).toHaveCount(0)
  await orcaPage.screenshot({
    path: testInfo.outputPath('shared-session-actions.png'),
    animations: 'disabled'
  })
})
