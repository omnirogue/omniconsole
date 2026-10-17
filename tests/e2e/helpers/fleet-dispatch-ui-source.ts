import type { ElectronApplication, Page } from '@stablyai/playwright-test'

export async function installFleetDispatchUiSource(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('runtime:call')
    ipcMain.handle('runtime:call', (_event, input: unknown) => {
      const request = input as { method: string; params: Record<string, unknown> }
      let result: unknown
      switch (request.method) {
        case 'nativeChat.readTranscriptPage': {
          const message = {
            id: 'fixture-turn',
            role: 'user',
            source: 'transcript',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Fixture: improve this proposal.' }]
          }
          const raw = JSON.stringify(message)
          const bytes = Buffer.byteLength(raw)
          result = {
            source: { connectionId: null },
            messages: [message],
            complete: true,
            sourceRecords: [{ byteOffset: 0, text: raw }],
            coverage: {
              format: 'jsonl',
              projection: 'display',
              fromByteOffset: 0,
              toByteOffset: bytes,
              snapshotBytes: bytes,
              rawRecords: 'complete'
            },
            malformedRecordCount: 0,
            oversizedRecordCount: 0,
            truncatedRecordCount: 0
          }
          break
        }
        case 'files.captureFleetSource':
          result = {
            snapshotId: 'c5993d9f-c6dc-4a0e-9e0d-4e1257c09dca',
            baseCommit: 'a'.repeat(40),
            remoteUrl: 'https://github.com/Fixture/project',
            branch: 'fixture',
            files: [],
            deletions: [],
            warnings: [],
            source: { connectionId: null }
          }
          break
        case 'files.releaseFleetSource':
          result = { released: true }
          break
        case 'terminal.resolvePane':
          result = {
            terminal: {
              ptyId: 'fixture-pty',
              handle: 'fixture-terminal',
              executionHostId: 'local'
            }
          }
          break
        case 'terminal.agentStatus':
          result = { agentStatus: { status: 'idle', isRunningAgent: true } }
          break
        default:
          return {
            id: 'fixture',
            ok: false,
            error: { code: 'method_not_found', message: `No fixture for ${request.method}` }
          }
      }
      return { id: 'fixture', ok: true, result }
    })
  })
}

export async function seedFleetDispatchUiSource(page: Page, title: string): Promise<void> {
  await page.evaluate((title) => {
    const store = window.__store!
    const state = store.getState()
    const worktreeId = state.activeWorktreeId!
    const workspace = state.getKnownWorktreeById(worktreeId)!
    const tabId = state.activeTabId!
    const leafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId
    if (!leafId) {
      throw new Error('The fixture source terminal has no leaf')
    }
    store.setState({
      repos: state.repos.map((repo) =>
        repo.id === workspace.repoId
          ? {
              ...repo,
              gitRemoteIdentity: {
                canonicalKey: 'github.com/Fixture/project',
                remoteName: 'origin',
                remoteUrl: 'https://github.com/Fixture/project'
              }
            }
          : repo
      ),
      worktreesByRepo: {
        ...state.worktreesByRepo,
        [workspace.repoId]: state.worktreesByRepo[workspace.repoId].map((item) =>
          item.id === worktreeId
            ? {
                ...item,
                linkedWorkItem: {
                  hubTaskId: 'btk_fixturefleet',
                  title,
                  provider: 'backoffice',
                  type: 'issue',
                  number: 0,
                  url: 'https://fixture.invalid/task'
                }
              }
            : item
        )
      },
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [worktreeId]: state.tabsByWorktree[worktreeId].map((tab) =>
          tab.id === tabId ? { ...tab, customTitle: title } : tab
        )
      }
    })
    store.getState().setAgentStatus(
      `${tabId}:${leafId}`,
      {
        state: 'done',
        prompt: title,
        agentType: 'codex',
        lastAssistantMessage: 'Ready to improve.'
      },
      title,
      undefined,
      { worktreeId, connectionId: null },
      {
        providerSession: {
          key: 'session_id',
          id: 'fixture-source-session',
          transcriptPath: '/fixture-only/source.jsonl'
        }
      }
    )
  }, title)
}
