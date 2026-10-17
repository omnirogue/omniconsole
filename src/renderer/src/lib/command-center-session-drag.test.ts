import { afterEach, expect, it } from 'vitest'
import { beginCommandCenterSessionDrag } from './command-center-session-drag'
import {
  getSessionSidebarDrag,
  clearSessionSidebarDrag,
  SESSION_ROW_DRAG_TYPE
} from './session-sidebar-drag'
import type { SidebarSession } from './sidebar-sessions'
afterEach(clearSessionSidebarDrag)
it('uses the exact bare host-qualified sidebar sessionKey MIME and keeps placement in process', () => {
  const values = new Map<string, string>()
  const data = {
    setData: (key: string, value: string) => {
      values.set(key, value)
    }
  } as unknown as DataTransfer
  const session = {
    sessionKey: '["runtime:peer","provider","codex","id"]',
    hostId: 'runtime:peer',
    worktreeId: 'wt',
    rowKey: 'row',
    tabId: 'tab',
    paneKey: null,
    kind: 'terminal',
    agent: 'codex',
    label: 'Session',
    workspaceLabel: 'Workspace',
    unavailable: false,
    folderKeyMigration: null
  } satisfies SidebarSession
  beginCommandCenterSessionDrag(data, session)
  expect(values.size).toBe(1)
  expect(values.get(SESSION_ROW_DRAG_TYPE)).toBe(session.sessionKey)
  expect(getSessionSidebarDrag()).toMatchObject({ kind: 'row', sessionKey: session.sessionKey })
})
