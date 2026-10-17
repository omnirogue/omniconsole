import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

test('task-save messages follow the host stream and clear with its confirmation', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  await orcaPage.evaluate(async () => {
    const settings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store!.setState({ settings })
  })
  // Only the test app's host responses are simulated; preload, stream reducer and DOM are real.
  await electronApp.evaluate(({ ipcMain }) => {
    const cursor = { epoch: 'save-ui-epoch', sequence: 0 }
    const page = {
      sessionId: 'save-ui-session',
      epoch: cursor.epoch,
      fence: 1,
      direction: 'tail',
      items: [],
      removedItemIds: [],
      submissions: [],
      window: { oldest: null, newest: null, nextCursor: cursor },
      liveCursor: cursor,
      hasOlder: false,
      hasNewer: false
    }
    ipcMain.removeHandler('runtime:call')
    ipcMain.handle('runtime:call', (_event, args) => ({
      id: 'test',
      ok: true,
      result:
        args.method === 'agentSession.history'
          ? { ok: true, page }
          : args.method === 'agentSession.options'
            ? { models: [], current: { model: '' } }
            : { ok: true }
    }))
    ipcMain.removeHandler('runtime:subscribe')
    ipcMain.handle('runtime:subscribe', (event, args) => {
      if (args.method !== 'agentSession.subscribe') {
        return { subscribed: false }
      }
      const send = (taskSave: unknown) =>
        event.sender.send(`runtime:subscription:${args.subscriptionId}`, {
          id: args.subscriptionId,
          ok: true,
          result: { type: 'snapshot', sessionId: 'save-ui-session', fence: 1, page, taskSave }
        })
      ipcMain.removeAllListeners('test:emit-task-save')
      ipcMain.on('test:emit-task-save', (state: string | null) =>
        send(state ? { taskId: 'btk_1234', state } : null)
      )
      send({ taskId: 'btk_1234', state: 'pending' })
      return { subscribed: true }
    })
  })
  await orcaPage.evaluate(
    ({ worktreeId, tabId }) => {
      const store = window.__store!
      const tabs = store.getState().unifiedTabsByWorktree[worktreeId]
      store.setState({
        unifiedTabsByWorktree: {
          ...store.getState().unifiedTabsByWorktree,
          [worktreeId]: tabs.map((tab) =>
            tab.entityId === tabId
              ? {
                  ...tab,
                  structuredSessionId: 'save-ui-session',
                  agentSessionAgent: 'codex',
                  viewMode: 'chat'
                }
              : tab
          )
        }
      })
    },
    { worktreeId: descriptor.worktreeId, tabId }
  )
  const pending = orcaPage
    .getByRole('status')
    .filter({ hasText: 'Task note saved · Waiting to sync' })
  await expect(pending).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('waiting-to-sync.png') })
  const send = async (state: string | null) =>
    electronApp.evaluate(({ ipcMain }, value) => {
      ipcMain.emit('test:emit-task-save', value)
    }, state)
  for (const [state, label] of [
    ['shared', 'Last task note shared'],
    ['attention', 'Task note could not be saved'],
    ['unavailable', 'Task note status unavailable'],
    ['saving', 'Saving task note…']
  ]) {
    await send(state)
    await expect(orcaPage.getByRole('status').filter({ hasText: label })).toBeVisible()
    await expect(pending).toHaveCount(0)
  }
  await send(null)
  await expect(orcaPage.getByRole('status').filter({ hasText: 'Saving task note…' })).toHaveCount(0)
})
