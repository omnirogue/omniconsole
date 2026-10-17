import { describe, expect, it, vi } from 'vitest'
import { emptyProjectSettings } from '../../../shared/project-settings'
import type { SessionFolderMetadata } from './session-folders'

const mocks = vi.hoisted(() => ({
  appState: {} as Record<string, unknown>,
  sessions: [] as Record<string, unknown>[],
  metadata: { version: 1, folders: [], membership: {} } as SessionFolderMetadata
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.appState } }))
vi.mock('@/store/session-folders', () => ({
  useSessionFolders: { getState: () => ({ metadata: mocks.metadata }) }
}))
vi.mock('./sidebar-sessions', () => ({ buildPaneSessions: () => mocks.sessions }))

import {
  sessionPrepProjectFolder,
  sessionPrepProjectFolderForPane
} from './session-prep-project-folder'

const settings = emptyProjectSettings(1)
const metadata: SessionFolderMetadata = {
  version: 1,
  folders: [
    { id: 'project', name: 'Checkout rewrite' },
    { id: 'project-sub', name: 'Payments', parentId: 'project' },
    { id: 'plain', name: 'Scratch' },
    { id: 'company', name: 'OmniOS' },
    { id: 'company-project', name: 'Billing', parentId: 'company' }
  ],
  membership: {
    'in-project': 'project',
    'in-subfolder': 'project-sub',
    'in-plain': 'plain',
    'in-company-project': 'company-project',
    'in-company': 'company',
    'in-missing': 'gone'
  },
  projects: { project: settings, 'company-project': settings }
}

describe('sessionPrepProjectFolder', () => {
  it.each([
    ['a session filed in a project', 'in-project', 'project'],
    ['a session in a subfolder of a project', 'in-subfolder', 'project'],
    ['a session in a project under a company folder', 'in-company-project', 'company-project'],
    ['a session in a plain folder', 'in-plain', null],
    ['a session in a company folder itself', 'in-company', null],
    ['a session whose folder is gone', 'in-missing', null],
    ['an unfiled session', 'unfiled', null],
    ['no session key', null, null]
  ])('%s', (_name, sessionKey, expected) => {
    expect(sessionPrepProjectFolder(metadata, sessionKey)).toBe(expected)
  })

  it('needs project settings on the folder, not only the folder shape', () => {
    expect(sessionPrepProjectFolder({ ...metadata, projects: {} }, 'in-project')).toBeNull()
  })
})

describe('sessionPrepProjectFolderForPane', () => {
  it('resolves through the session that owns the pane', () => {
    mocks.metadata = metadata
    mocks.sessions = [
      { paneKey: 'pane-1', tabId: 'tab-1', kind: 'terminal', sessionKey: 'in-subfolder' },
      { paneKey: null, tabId: 'tab-2', kind: 'structured', sessionKey: 'in-plain' }
    ]
    expect(sessionPrepProjectFolderForPane('pane-1', 'tab-1')).toBe('project')
    expect(sessionPrepProjectFolderForPane('pane-9', 'tab-2')).toBeNull()
    expect(sessionPrepProjectFolderForPane('pane-9', 'tab-9')).toBeNull()
  })
})
