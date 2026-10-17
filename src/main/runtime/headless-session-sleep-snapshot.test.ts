import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import { sidebarRow } from '../session-manage/session-manage-test-fixtures'

const LEAF = '00000000-0000-4000-8000-000000000001'
const PANE = `tab:${LEAF}`

function fixture(folder = false) {
  const worktreeId = folder ? 'folder:email' : 'repo::/work/other'
  let pinned = false
  const runtime = new OrcaRuntimeService({
    getWorktreeMeta: () => ({ isPinned: pinned }),
    getFolderWorkspaces: () => [{ id: 'email', isPinned: pinned }]
  } as never)
  const row = sidebarRow({
    worktreeId,
    paneKey: PANE,
    tabId: 'tab',
    hostId: 'local',
    hostUnavailable: false,
    folded: false,
    launchPending: false,
    pinned: false
  })
  const hook = {
    agentType: 'codex',
    state: 'done',
    stateStartedAt: 10,
    receivedAt: 10,
    providerSession: {
      key: 'session_id',
      id: 'provider',
      transcriptPath: '/home/account/sessions/provider.jsonl'
    }
  }
  Object.assign(runtime, {
    resolveWorktreeSelector: async () => ({ id: worktreeId, path: '/work/other', isPinned: false }),
    resolveTerminalPane: () => ({ ptyId: 'pty', handle: 'handle' }),
    getWorkspaceSessionForWorktree: () => ({
      tabsByWorktree: {
        [worktreeId]: [{ id: 'tab', worktreeId, createdAt: 1, isPinned: false }]
      }
    }),
    getFreshAgentHookStatusForHandle: () => hook,
    getLastAgentHookRowForPane: () => hook,
    hasConversationCapacityOwner: () => false,
    hasExactPersistedTerminalSurfaceIdentity: () => true,
    listAutomations: () => [],
    listAutomationRuns: () => [],
    ptysById: new Map([
      [
        'pty',
        {
          ptyId: 'pty',
          connected: true,
          incarnationId: 'inc',
          launchConfig: { agentCommand: 'codex', agentEnv: { CODEX_HOME: '/home/account' } }
        }
      ]
    ])
  })
  return {
    runtime,
    row,
    pin: () => {
      pinned = true
    }
  }
}

describe('headless snapshot pin protection', () => {
  it.each([false, true])(
    'reads current persisted workspace pin with a stale sidebar row (folder=%s)',
    async (folder) => {
      const f = fixture(folder)
      expect((await f.runtime.readHeadlessSleepSnapshot(f.row))?.row.pinned).toBe(false)
      expect(f.runtime.getAutomaticCleanupTab(f.row.worktreeId, PANE)?.isPinned).toBe(false)
      f.pin()
      expect(f.row.pinned).toBe(false)
      expect((await f.runtime.readHeadlessSleepSnapshot(f.row))?.row.pinned).toBe(true)
      expect(f.runtime.getAutomaticCleanupTab(f.row.worktreeId, PANE)?.isPinned).toBe(true)
    }
  )
})
