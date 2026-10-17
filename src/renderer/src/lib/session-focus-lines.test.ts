import { describe, expect, it } from 'vitest'
import type { AgentPaneCard, AttentionPane } from '@/components/attention/agent-pane-snapshot'
import type { ConsoleWorkflowJob } from '../../../shared/console-workflow-types'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import { emptySessionFolderMetadata, type SessionFolder } from './session-folders'
import {
  buildSessionFocusLines,
  SESSION_FOCUS_LINE_LIMIT,
  sessionFocusLineCount,
  sessionFocusNeedsYouCount,
  sessionFocusQuestion,
  sessionFocusTopQuestion
} from './session-focus-lines'
import { emptySessionSidebarView } from './session-sidebar-view'
import { buildSessionSidebarTree, sessionFolderGroupKey } from './session-sidebar-tree'
import type { SidebarSession } from './sidebar-sessions'
import {
  estimateSessionFocusLines,
  type SessionFocusRow
} from '../../../shared/session-organize-focus'

const now = 1_000_000_000_000

const folderId = (index: number) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`

function session(key: string, over: Partial<SidebarSession> = {}): SidebarSession {
  return {
    rowKey: key,
    sessionKey: key,
    worktreeId: 'w1',
    hostId: 'local',
    tabId: `tab-${key}`,
    paneKey: `tab-${key}:leaf`,
    kind: 'terminal',
    label: key,
    workspaceLabel: 'Website / main',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null,
    ...over
  }
}

function card(key: string, dotState: AgentPaneCard['dotState'], age = 1000): AgentPaneCard {
  return {
    paneKey: `tab-${key}:leaf`,
    worktreeId: 'w1',
    tabId: `tab-${key}`,
    leafId: 'leaf',
    agentType: 'codex',
    bucket: dotState === 'working' ? 'working' : 'idle',
    dotState,
    unseen: false,
    title: key,
    stateChangedAt: now - age,
    repoName: 'Website',
    worktreeName: 'main'
  } as AgentPaneCard
}

type Spec = {
  key: string
  folder?: number
  state?: 'working' | 'done' | 'idle'
  /** Asking the person; a larger age is an older, more urgent wait. */
  ask?: { age: number; summary?: string }
  waitMinutes?: number
  archived?: boolean
  hidden?: boolean
}

function focusLines(specs: Spec[], folders: SessionFolder[], hiddenFolders: number[] = []) {
  const sessions = specs.map((spec) =>
    // Why keep an asking hidden row's pane: a row with no pane has no question to ask.
    session(spec.key, spec.hidden ? { tabId: null, ...(spec.ask ? {} : { paneKey: null }) } : {})
  )
  const cards = specs
    .filter((spec) => spec.state && spec.state !== 'idle' && !spec.ask)
    .map((spec) => card(spec.key, spec.state as AgentPaneCard['dotState']))
  const attention = new Map<string, AttentionPane>(
    specs.flatMap((spec) =>
      spec.ask
        ? [
            [
              `tab-${spec.key}:leaf`,
              {
                ...card(spec.key, 'waiting', spec.ask.age),
                bucket: 'attention',
                cause: 'waiting',
                portalPaneKey: `tab-${spec.key}:leaf`,
                askSummary: spec.ask.summary
              } as AttentionPane
            ]
          ]
        : []
    )
  )
  const tree = buildSessionSidebarTree({
    now,
    sessions,
    metadata: {
      ...emptySessionFolderMetadata(),
      folders,
      membership: Object.fromEntries(
        specs.flatMap((spec) =>
          spec.folder === undefined ? [] : [[spec.key, folderId(spec.folder)]]
        )
      )
    },
    view: {
      ...emptySessionSidebarView(),
      hidden: [
        ...specs.filter((spec) => spec.hidden).map((spec) => `conversation:${spec.key}`),
        ...hiddenFolders.map((index) => sessionFolderGroupKey(folderId(index)))
      ]
    },
    snapshot: {
      cardsByPaneKey: new Map(cards.map((entry) => [entry.paneKey, entry])),
      cardsByTabId: new Map(),
      attentionByPaneKey: attention
    },
    waitingUntilByPaneKey: new Map(
      specs.flatMap((spec) =>
        spec.waitMinutes === undefined
          ? []
          : [[`tab-${spec.key}:leaf`, new Date(now + spec.waitMinutes * 60_000).toISOString()]]
      )
    ),
    query: '',
    showHidden: false,
    showArchived: false,
    archivedKeys: new Set(specs.filter((spec) => spec.archived).map((spec) => spec.key))
  })
  return buildSessionFocusLines(tree.groups, now, tree.putAwayAsks)
}

const emptyGroup = (key: string, kind: 'attention' | 'hidden') => ({
  key,
  kind,
  label: key,
  folder: undefined,
  rows: [],
  hidden: false
})

const folderList = (count: number, parents: Record<number, number> = {}): SessionFolder[] =>
  Array.from({ length: count }, (_, index) => ({
    id: folderId(index),
    name: `Folder ${index}`,
    ...(parents[index] === undefined ? {} : { parentId: folderId(parents[index]) })
  }))

/** A busy estate: every third session works, every seventh asks, the rest are done or idle. */
function busy(total: number, folderCount: number): { specs: Spec[]; asking: number } {
  let asking = 0
  const specs = Array.from({ length: total }, (_, index): Spec => {
    const spec: Spec = { key: `s${index}`, folder: index % (folderCount + 1) || undefined }
    if (index % 7 === 0) {
      asking += 1
      return { ...spec, ask: { age: 1000 + index } }
    }
    return { ...spec, state: index % 3 === 0 ? 'working' : index % 2 ? 'done' : 'idle' }
  })
  return { specs, asking }
}

describe('buildSessionFocusLines', () => {
  it.each([
    [30, 9],
    [100, 20]
  ])('keeps %i sessions in %i folders within five lines', (total, folderCount) => {
    const { specs, asking } = busy(total, folderCount)
    const lines = focusLines(specs, folderList(folderCount + 1))
    expect(sessionFocusLineCount(lines)).toBeLessThanOrEqual(SESSION_FOCUS_LINE_LIMIT)
    expect(lines.needsYou?.rows).toHaveLength(asking)
    expect(lines.folders).toHaveLength(3)
    const shownFolderSessions = lines.folders.reduce(
      (sum, line) => sum + (line.tally.total - line.tally.needsYou),
      0
    )
    expect(lines.everythingElse.sessions).toBe(total - asking - shownFolderSessions)
  })

  it('folds eight questions into one Needs you line, the oldest wait first', () => {
    const specs: Spec[] = Array.from({ length: 8 }, (_, index) => ({
      key: `q${index}`,
      folder: index % 3 === 0 ? undefined : index % 2,
      ask: { age: index === 5 ? 90_000 : 1000 + index, summary: `Question ${index}` }
    }))
    const lines = focusLines(specs, folderList(2))
    expect(lines.needsYou?.rows).toHaveLength(8)
    expect(sessionFocusQuestion(lines.needsYou!.rows[0]!)).toBe('Question 5')
    expect(sessionFocusLineCount(lines)).toBeLessThanOrEqual(SESSION_FOCUS_LINE_LIMIT)
  })

  it('names the most urgent question by its text, and keeps three questions in one line', () => {
    const json = (question: string) =>
      JSON.stringify({ questions: [{ question, multiSelect: false, options: [{ label: 'Yes' }] }] })
    const specs: Spec[] = [0, 1, 2].map((index) => ({
      key: `q${index}`,
      ask: { age: 1000 * (3 - index), summary: json(`Deploy step ${index}?`) }
    }))
    const lines = focusLines(specs, folderList(2))
    expect(lines.needsYou?.rows).toHaveLength(3)
    expect(sessionFocusQuestion(lines.needsYou!.rows[0]!)).toBe('Deploy step 0?')
    expect(sessionFocusLineCount(lines)).toBeLessThanOrEqual(SESSION_FOCUS_LINE_LIMIT)
  })

  it('shows only Everything else on a quiet day', () => {
    const specs: Spec[] = Array.from({ length: 12 }, (_, index) => ({
      key: `d${index}`,
      folder: index % 4 || undefined,
      state: index % 2 ? 'done' : 'idle'
    }))
    const lines = focusLines(specs, folderList(4))
    expect(lines.needsYou).toBeNull()
    expect(lines.folders).toEqual([])
    expect(lines.everythingElse).toEqual({ sessions: 12, folders: 3 })
    expect(sessionFocusLineCount(lines)).toBe(1)
  })

  it('gives a question one line, never its folder a second one', () => {
    const specs: Spec[] = [
      ...Array.from({ length: 5 }, (_, index): Spec => ({
        key: `w${index}`,
        folder: 0,
        state: 'working'
      })),
      ...Array.from({ length: 3 }, (_, index): Spec => ({
        key: `v${index}`,
        folder: 1,
        state: 'working'
      })),
      { key: 'ask', folder: 2, ask: { age: 5000 } },
      { key: 'soon', folder: 3, waitMinutes: 20 }
    ]
    const lines = focusLines(specs, folderList(4))
    expect(lines.needsYou?.rows.map((row) => row.session.rowKey)).toEqual(['ask'])
    expect(lines.folders.map((line) => [line.key, line.rank])).toEqual([
      [sessionFolderGroupKey(folderId(0)), 'working'],
      [sessionFolderGroupKey(folderId(1)), 'working'],
      [sessionFolderGroupKey(folderId(3)), 'waitingSoon']
    ])
    expect(sessionFocusLineCount(lines)).toBe(SESSION_FOCUS_LINE_LIMIT)
  })

  it('counts questions from hidden folders, hidden rows and archived sessions in Needs you', () => {
    const specs: Spec[] = [
      { key: 'busy', folder: 0, state: 'working' },
      { key: 'tucked-ask', folder: 1, ask: { age: 3000 } },
      { key: 'deeper-ask', folder: 2, ask: { age: 2000 } },
      { key: 'tucked-work', folder: 1, state: 'working' },
      { key: 'hidden-ask', hidden: true, ask: { age: 1000 } },
      { key: 'archived-ask', archived: true, ask: { age: 500, summary: 'Ship it?' } },
      { key: 'archived-work', archived: true, state: 'working' }
    ]
    const lines = focusLines(specs, folderList(3, { 2: 1 }), [1])
    expect(lines.needsYou?.rows.map((row) => row.session.rowKey).sort()).toEqual(
      ['archived-ask', 'deeper-ask', 'hidden-ask', 'tucked-ask'].sort()
    )
    const archived = lines.needsYou!.rows.find((row) => row.session.rowKey === 'archived-ask')!
    expect(sessionFocusQuestion(archived)).toBe('Ship it?')
    expect(lines.folders.map((line) => line.label)).toEqual(['Folder 0'])
  })

  it('counts a fleet run that needs the person, wherever its receipt is listed', () => {
    const fleetRun = (workflowId: string, job: Partial<ConsoleWorkflowJob>) => ({
      run: {
        workflowId,
        rowKey: workflowId,
        sessionKey: workflowId,
        title: `Run ${workflowId}`,
        admission: 'accepted',
        verified: true,
        jobs: [job as ConsoleWorkflowJob]
      } as ConversationFleetView,
      source: null
    })
    const tree = [
      {
        ...emptyGroup('attention', 'attention'),
        fleetRows: [fleetRun('wf_decide', { status: 'blocked', can_decide: true })]
      },
      {
        ...emptyGroup('hidden-conversations', 'hidden'),
        fleetRows: [
          fleetRun('wf_review', { status: 'pr_open', pr_url: 'https://example.test/pr/1' }),
          fleetRun('wf_running', { status: 'running' })
        ]
      }
    ]
    const lines = buildSessionFocusLines(tree, now)
    expect(lines.needsYou?.rows).toEqual([])
    expect(lines.needsYou?.fleetRows.map((row) => row.run.workflowId)).toEqual([
      'wf_decide',
      'wf_review'
    ])
    expect(sessionFocusNeedsYouCount(lines.needsYou!)).toBe(2)
    expect(sessionFocusTopQuestion(lines.needsYou!)).toBe('Run wf_decide')
    expect(sessionFocusLineCount(lines)).toBe(2)
  })

  it('gives a fourth folder the Needs you line when nothing asks, Unfiled included', () => {
    const specs: Spec[] = [
      ...[0, 1, 2].map((folder): Spec => ({ key: `w${folder}`, folder, state: 'working' })),
      { key: 'loose', state: 'working' },
      { key: 'soon', folder: 3, waitMinutes: 20 }
    ]
    const lines = focusLines(specs, folderList(4))
    expect(lines.needsYou).toBeNull()
    expect(lines.folders.map((line) => line.label)).toEqual([
      'Folder 0',
      'Folder 1',
      'Folder 2',
      'Unfiled'
    ])
    expect(lines.everythingElse).toEqual({ sessions: 1, folders: 1 })
    expect(sessionFocusLineCount(lines)).toBe(5)
  })

  it('never counts hidden, snoozed or archived sessions', () => {
    const specs: Spec[] = [
      { key: 'open', folder: 0, state: 'done' },
      { key: 'gone', folder: 0, state: 'working', archived: true },
      { key: 'tucked', state: 'working', hidden: true },
      { key: 'later', folder: 1, waitMinutes: 180 },
      { key: 'soon', folder: 2, waitMinutes: 30 }
    ]
    const lines = focusLines(specs, folderList(3))
    expect(lines.folders.map((line) => [line.label, line.rank])).toEqual([
      ['Folder 2', 'waitingSoon']
    ])
    expect(lines.everythingElse).toEqual({ sessions: 1, folders: 1 })
  })

  it('rolls a nested folder up into its top-level folder', () => {
    const specs: Spec[] = [
      { key: 'deep', folder: 1, state: 'working' },
      { key: 'top', folder: 0, state: 'done' }
    ]
    const lines = focusLines(specs, folderList(2, { 1: 0 }))
    expect(lines.folders.map((line) => [line.label, line.tally.working, line.tally.total])).toEqual(
      [['Folder 0', 1, 2]]
    )
    expect(lines.everythingElse.sessions).toBe(0)
  })
})

/** The same sessions as `omni session organize` reads them (folder paths, states, flags). */
function organizeRows(specs: Spec[], folders: SessionFolder[]): SessionFocusRow[] {
  const path = (index: number): string => {
    const folder = folders[index]!
    const parent = folders.findIndex((entry) => entry.id === folder.parentId)
    return parent === -1 ? folder.name : `${path(parent)} / ${folder.name}`
  }
  return specs.map((spec) => ({
    folder: spec.folder === undefined ? null : path(spec.folder),
    archived: spec.archived === true,
    hidden: spec.hidden === true,
    snoozed: (spec.waitMinutes ?? 0) > 60,
    state: spec.ask
      ? 'awaiting-user'
      : spec.state === 'working'
        ? 'working'
        : spec.state === 'done'
          ? 'exited'
          : 'idle'
  }))
}

describe('one count for the focus view and the organize dry run', () => {
  const put_away: Spec[] = [
    { key: 'gone', folder: 1, state: 'working', archived: true },
    { key: 'tucked', folder: 2, state: 'working', hidden: true },
    { key: 'later', folder: 3, state: 'working', waitMinutes: 180 },
    { key: 'deep', folder: 5, state: 'working' },
    { key: 'loose', state: 'working' }
  ]
  it.each([
    ['a busy estate', busy(30, 5).specs, 6],
    ['a larger one', busy(100, 9).specs, 10],
    ['a quiet day', busy(12, 3).specs.map((spec) => ({ ...spec, ask: undefined })), 4],
    ['put-away, nested and unfiled work', [...busy(9, 2).specs, ...put_away], 6],
    ['nothing asking, two folders busy', put_away, 6],
    [
      'an archived session that asks',
      [...put_away, { key: 'archived-ask', folder: 1, archived: true, ask: { age: 700 } }],
      6
    ]
  ])('%s', (_name, specs, folderCount) => {
    const folders = folderList(folderCount, { 5: 0 })
    const view = focusLines(specs, folders)
    const topLevel = folders.filter((folder) => !folder.parentId).map((folder) => folder.name)
    const dryRun = estimateSessionFocusLines(organizeRows(specs, folders), topLevel)
    expect(dryRun.lines).toBe(sessionFocusLineCount(view))
    expect(dryRun.needsYou).toBe(view.needsYou?.rows.length ?? 0)
    expect(dryRun.folders).toEqual(view.folders.map((line) => line.label))
    expect(dryRun.everythingElse).toEqual(view.everythingElse)
  })
})
