import { describe, expect, it } from 'vitest'
import type { ConsoleJiraWorkRef } from '../../../shared/console-jira-work-contract'
import type { SessionChain } from '../../../shared/session-chain-types'
import { sessionFolderTallies, sessionProjectThreadStatus } from './session-folder-rollup'
import {
  filterSessionProjectThreads,
  sessionProjectThreads,
  type SessionProjectThread
} from './session-project-threads'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'
import { buildSidebarSessions, type SidebarSession } from './sidebar-sessions'
import { EMPTY_AGENT_PANE_SNAPSHOT } from '@/components/attention/agent-pane-snapshot'
import { buildSessionSidebarTreeRows } from './session-sidebar-tree-rows'
import { emptySessionSidebarView } from './session-sidebar-view'
import {
  ledgerBucket,
  ledgerRecord,
  ledgerSlices,
  pairedSource
} from './mirrored-conversation-test-fixtures'

const PROJECT = 'project'
const FOLDERS = [
  { id: PROJECT, name: 'Ads' },
  { id: 'research', name: 'Research', parentId: PROJECT },
  { id: 'other', name: 'Other' }
]
const leaf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SEALED_FOR_REVIEW = {
  outcomeSet: {
    outcomes: [{ evidence: [{ receipt: 'done-for-review:draft-1' }] }]
  }
} as unknown as SessionChain
const ADS_7: ConsoleJiraWorkRef = {
  provider: 'jira',
  cloud_id: 'bb6f9191-a21a-4857-b965-32de82dce68b',
  issue_id: '10007',
  issue_key: 'ADS-7',
  project_key: 'ADS'
}

function row(
  n: number,
  over: Partial<SessionSidebarTreeRow> = {},
  session: Partial<SidebarSession> = {}
): SessionSidebarTreeRow {
  return {
    session: {
      rowKey: `row-${n}`,
      sessionKey: `session-${n}`,
      worktreeId: `w${n}`,
      hostId: 'local',
      tabId: `tab-${n}`,
      paneKey: `tab-${n}:${leaf(n)}`,
      kind: 'terminal',
      label: `Thread ${n}`,
      workspaceLabel: 'Website / main',
      agent: 'codex',
      unavailable: false,
      folderKeyMigration: null,
      ...session
    },
    folderId: null,
    attention: null,
    state: 'idle',
    waitingUntil: null,
    ...over
  }
}

describe('sessionProjectThreadStatus', () => {
  it('splits a finished row into Ready for review and Completed', () => {
    expect(sessionProjectThreadStatus(row(1))).toBe('done')
    expect(sessionProjectThreadStatus(row(1, { unreadCompletion: true }))).toBe('reviewReady')
    expect(sessionProjectThreadStatus(row(1, { pursuitChain: SEALED_FOR_REVIEW }))).toBe(
      'reviewReady'
    )
    expect(sessionProjectThreadStatus(row(1), undefined, true)).toBe('reviewReady')
  })

  it('leaves archived, unfinished and asking rows where the folder tally puts them', () => {
    expect(sessionProjectThreadStatus(row(1, { archived: true, unreadCompletion: true }))).toBe(
      'done'
    )
    expect(sessionProjectThreadStatus(row(1, { state: 'working' }), undefined, true)).toBe(
      'working'
    )
    expect(sessionProjectThreadStatus(row(1, { state: null }), undefined, true)).toBeNull()
    expect(sessionProjectThreadStatus(row(1, { planNeedsYou: true, unreadCompletion: true }))).toBe(
      'needsYou'
    )
  })
})

describe('sessionFolderTallies reviewReady', () => {
  it('counts Ready for review inside done and adds it up the tree', () => {
    const tallies = sessionFolderTallies(
      FOLDERS,
      [
        row(1, { folderId: 'research', unreadCompletion: true }),
        row(2, { folderId: PROJECT }),
        row(3, { folderId: PROJECT }),
        row(4, { folderId: 'other' })
      ],
      new Map(),
      (entry) => entry.session.rowKey === 'row-3'
    )
    expect(tallies.get(PROJECT)).toMatchObject({
      done: 3,
      reviewReady: 2,
      total: 3
    })
    expect(tallies.get('research')).toMatchObject({ done: 1, reviewReady: 1 })
    expect(tallies.get('other')).not.toHaveProperty('reviewReady')
  })
})

describe('sessionProjectThreads', () => {
  const lineage = new Map([
    [leaf(5), leaf(1)],
    [leaf(6), leaf(5)],
    [leaf(7), leaf(4)]
  ])
  const rows = [
    row(1, { folderId: PROJECT }),
    row(2, { folderId: 'research', state: 'working' }),
    row(4, { folderId: 'other' }),
    row(5),
    row(6, { state: 'working' }),
    row(7),
    row(8, {}, { sessionKey: 'coordinator' })
  ]

  it("lists the subtree, the workers it dispatched and the project's chat", () => {
    const threads = sessionProjectThreads(FOLDERS, rows, PROJECT, {
      workerParentByLeaf: lineage,
      coordinatorSessionKey: 'coordinator'
    })
    expect(threads.map((thread) => [thread.row.session.rowKey, thread.isCoordinator])).toEqual([
      ['row-1', false],
      ['row-2', false],
      ['row-5', false],
      ['row-6', false],
      ['row-8', true]
    ])
    expect(threads.map((thread) => thread.status)).toEqual([
      'done',
      'working',
      'done',
      'working',
      'done'
    ])
  })

  it('does not use a remembered leaf link to choose among host copies of a worker or parent', () => {
    const otherHost = row(9, {}, { paneKey: `mirror:${leaf(5)}`, hostId: 'runtime:remote' })
    expect(
      sessionProjectThreads(FOLDERS, [...rows, otherHost], PROJECT, {
        workerParentByLeaf: lineage
      }).map((thread) => thread.row.session.rowKey)
    ).toEqual(['row-1', 'row-2'])
    const otherParent = row(
      10,
      { folderId: 'other' },
      {
        paneKey: `mirror:${leaf(1)}`,
        hostId: 'runtime:remote'
      }
    )
    expect(
      sessionProjectThreads(FOLDERS, [...rows, otherParent], PROJECT, {
        workerParentByLeaf: lineage
      }).map((thread) => thread.row.session.rowKey)
    ).toEqual(['row-1', 'row-2'])
  })

  it('reads an open review only for a lone thread in its workspace, never for the chat', () => {
    const shared = [
      row(1, { folderId: PROJECT }),
      row(2, { folderId: PROJECT }, { worktreeId: 'w1' }),
      row(3, { folderId: PROJECT }),
      row(8, {}, { sessionKey: 'coordinator' })
    ]
    const asked: string[] = []
    const threads = sessionProjectThreads(FOLDERS, shared, PROJECT, {
      coordinatorSessionKey: 'coordinator',
      hostedReviewOpen: (entry) => {
        asked.push(entry.session.rowKey)
        return true
      }
    })
    expect(asked).toEqual(['row-3'])
    expect(threads.map((thread) => thread.status)).toEqual(['done', 'done', 'reviewReady', 'done'])
  })

  it("carries the thread's model, host, issue and last report", () => {
    const [thread] = sessionProjectThreads(
      FOLDERS,
      [row(1, { folderId: PROJECT }, { hostId: 'ssh:mac-studio' })],
      PROJECT,
      {
        agentStatusByPaneKey: {
          [`tab-1:${leaf(1)}`]: { model: 'gpt-5.5', updatedAt: 42 }
        },
        taskLinkByPaneKey: {
          [`tab-1:${leaf(1)}`]: { taskId: 'jira:x', workRef: ADS_7 }
        }
      }
    )
    expect(thread).toMatchObject({
      agent: 'codex',
      model: 'gpt-5.5',
      host: 'ssh:mac-studio',
      jira: ADS_7,
      lastActivityAt: 42
    })
    const [bare] = sessionProjectThreads(FOLDERS, [row(1, { folderId: PROJECT })], PROJECT)
    expect(bare).not.toHaveProperty('model')
    expect(bare).not.toHaveProperty('origin')
    expect(bare?.lastActivityAt).toBeNull()
  })

  it('names the task that started a worker, and whether the chat sent it', () => {
    const chatPane = `tab-8:${leaf(8)}`
    const threads = sessionProjectThreads(FOLDERS, rows, PROJECT, {
      workerParentByLeaf: lineage,
      coordinatorSessionKey: 'coordinator',
      agentStatusByPaneKey: {
        [`tab-5:${leaf(5)}`]: {
          orchestration: { taskTitle: ' Fix checkout ', parentPaneKey: chatPane }
        },
        [`tab-6:${leaf(6)}`]: { orchestration: { taskTitle: 'Stale', parentPaneKey: chatPane } }
      },
      // The runtime's context wins over a hook report for the same pane.
      orchestrationByPaneKey: {
        [`tab-6:${leaf(6)}`]: { taskTitle: 'Write tests', parentPaneKey: `tab-5:${leaf(5)}` }
      }
    })
    const origins = Object.fromEntries(
      threads.map((thread) => [thread.row.session.rowKey, thread.origin])
    )
    expect(origins).toEqual({
      'row-1': undefined,
      'row-2': undefined,
      'row-5': { task: 'Fix checkout', fromChat: true },
      'row-6': { task: 'Write tests', fromChat: false },
      'row-8': undefined
    })
  })
})

describe('filterSessionProjectThreads', () => {
  const thread = (
    n: number,
    over: Partial<SessionProjectThread> = {},
    rowOver: Partial<SessionSidebarTreeRow> = {}
  ): SessionProjectThread => ({
    row: row(n, rowOver),
    status: 'done',
    isCoordinator: false,
    agent: 'codex',
    lastActivityAt: null,
    ...over
  })
  const threads = [
    thread(1, { status: 'working', agent: 'claude' }),
    thread(2, { status: 'reviewReady', model: 'claude-opus-5' }),
    thread(3, { host: 'ssh:mac-studio', jira: ADS_7 }),
    thread(4, {}, { archived: true }),
    thread(5, { isCoordinator: true }, { archived: true })
  ]
  const keys = (filter: Parameters<typeof filterSessionProjectThreads>[1]): string[] =>
    filterSessionProjectThreads(threads, filter).map((entry) => entry.row.session.rowKey)

  it("hides archived threads unless asked, but never the project's chat", () => {
    expect(keys({})).toEqual(['row-1', 'row-2', 'row-3', 'row-5'])
    expect(keys({ includeArchived: true })).toHaveLength(5)
  })

  it('filters by status, agent, model family, host and issue', () => {
    expect(keys({ statuses: ['reviewReady', 'working'] })).toEqual(['row-1', 'row-2'])
    expect(keys({ agents: ['claude'] })).toEqual(['row-1'])
    expect(keys({ modelFamilies: ['anthropic'] })).toEqual(['row-1', 'row-2'])
    expect(keys({ hosts: ['ssh:mac-studio'] })).toEqual(['row-3'])
    expect(keys({ tasks: ['ADS-7'] })).toEqual(['row-3'])
    expect(keys({ tasks: ['none'], statuses: ['done'] })).toEqual(['row-5'])
  })
})

describe('a paired owner’s conversation in a project (session parity, step 6)', () => {
  it("lists a row the owner filed in the project's subtree as one of its threads", () => {
    const source = pairedSource()
    Object.assign(
      source,
      ledgerSlices([
        ledgerBucket([
          ledgerRecord('s1', { folderId: 'research' }),
          ledgerRecord('s2', { folderId: 'other' })
        ])
      ])
    )
    const sessions = buildSidebarSessions(source)
    const { rows } = buildSessionSidebarTreeRows(
      {
        sessions,
        metadata: { version: 1, folders: FOLDERS, membership: {} },
        view: emptySessionSidebarView(),
        snapshot: EMPTY_AGENT_PANE_SNAPSHOT,
        query: '',
        showHidden: true
      },
      1_000
    )
    const threads = sessionProjectThreads(FOLDERS, rows, PROJECT)
    expect(threads.map((thread) => thread.row.session.label)).toEqual(['Owner s1'])
    expect(threads[0]?.row.folderId).toBe('research')
    expect(threads[0]?.host).toBe('runtime:env-studio')
  })
})
