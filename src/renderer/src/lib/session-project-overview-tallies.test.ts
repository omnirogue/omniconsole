import { describe, expect, it } from 'vitest'
import { emptyProjectSettings } from '../../../shared/project-settings'
import type { SessionFolderMetadata } from './session-folders'
import { sessionProjectOverviewTallies } from './session-project-overview-tallies'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'

const PROJECT = '00000000-0000-4000-8000-000000000001'
const metadata: SessionFolderMetadata = {
  version: 1,
  folders: [{ id: PROJECT, name: 'Website' }],
  membership: {}
}
const leaf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function row(n: number, overrides: Partial<SessionSidebarTreeRow> = {}): SessionSidebarTreeRow {
  return {
    session: {
      rowKey: `row-${n}`,
      sessionKey: `session-${n}`,
      worktreeId: `workspace-${n}`,
      hostId: 'local',
      tabId: `tab-${n}`,
      paneKey: `tab-${n}:${leaf(n)}`,
      kind: 'terminal',
      label: `Thread ${n}`,
      workspaceLabel: 'Website',
      agent: 'codex',
      unavailable: false,
      folderKeyMigration: null
    },
    folderId: PROJECT,
    attention: null,
    state: 'idle',
    waitingUntil: null,
    ...overrides
  }
}

describe('project overview review counts', () => {
  it('does not count one workspace review once for each of its completed threads', () => {
    const first = row(1)
    const second = row(2)
    second.session.worktreeId = first.session.worktreeId
    expect(
      sessionProjectOverviewTallies(metadata, [first, second, row(3)], {
        hostedReviewOpen: () => true
      }).get(PROJECT)
    ).toMatchObject({ done: 3, total: 3, reviewReady: 1 })
  })

  it('suppresses only the recorded coordinator’s workspace review signal', () => {
    const configured = {
      ...metadata,
      projects: {
        [PROJECT]: {
          ...emptyProjectSettings(1),
          coordinator: { launch: { agent: 'codex' as const }, sessionKey: 'session-1' }
        }
      }
    }
    const coordinator = row(1)
    const inputs = { hostedReviewOpen: () => true }
    expect(
      sessionProjectOverviewTallies(configured, [coordinator], inputs).get(PROJECT)
    ).toMatchObject({ done: 1, total: 1, reviewReady: 0 })
    coordinator.unreadCompletion = true
    expect(
      sessionProjectOverviewTallies(configured, [coordinator], inputs).get(PROJECT)
    ).toMatchObject({ done: 1, total: 1, reviewReady: 1 })
  })

  it('includes an unfiled worker’s review without changing legacy folder totals', () => {
    const parent = row(1, { state: 'working' })
    const worker = row(2, { folderId: null, unreadCompletion: true })
    expect(
      sessionProjectOverviewTallies(metadata, [parent, worker], {
        workerParentByLeaf: new Map([[leaf(2), leaf(1)]])
      }).get(PROJECT)
    ).toMatchObject({ working: 1, done: 0, total: 1, reviewReady: 1 })
  })

  it('does not promote archived or unavailable threads with an open review', () => {
    expect(
      sessionProjectOverviewTallies(
        metadata,
        [row(1, { archived: true }), row(2, { activityUnverifiable: true })],
        { hostedReviewOpen: () => true }
      ).get(PROJECT)
    ).toMatchObject({ done: 1, cantSee: 1, total: 2, reviewReady: 0 })
  })
})
