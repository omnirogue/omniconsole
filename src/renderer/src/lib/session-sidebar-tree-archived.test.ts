import { describe, expect, it } from 'vitest'
import type { AgentPaneCard } from '@/components/attention/agent-pane-snapshot'
import {
  classifyConversation,
  CONVERSATION_ARCHIVED_AFTER_MS,
  CONVERSATION_COMPLETED_AFTER_MS
} from './conversation-retention'
import { emptySessionFolderMetadata, SAVED_SESSIONS_FOLDER_ID } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'
import { buildSessionSidebarTree } from './session-sidebar-tree'
import { conversationPlanFixture } from './conversation-plan-fixture'
import { buildSidebarSessions, type SidebarSession } from './sidebar-sessions'
import { conversationViewKey } from './conversation-view'
import {
  addMirrorTab,
  ledgerBucket,
  ledgerRecord,
  ledgerSlices,
  OWNER_PANE,
  pairedSource
} from './mirrored-conversation-test-fixtures'
import { SESSION_TEST_LEAF } from './sidebar-session-test-fixtures'
import type { SessionChain } from '../../../shared/session-chain-types'

const now = 1_000_000_000

function session(key: string, label: string): SidebarSession {
  return {
    rowKey: key,
    sessionKey: key,
    worktreeId: 'w1',
    hostId: 'local',
    tabId: `tab-${key}`,
    paneKey: `tab-${key}:leaf`,
    kind: 'terminal',
    label,
    workspaceLabel: 'Website / main',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null
  }
}

function workingCard(paneKey: string): AgentPaneCard {
  return {
    paneKey,
    worktreeId: 'w1',
    tabId: paneKey.split(':')[0]!,
    leafId: 'leaf',
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    unseen: false,
    title: 'task',
    stateChangedAt: now - 1000,
    repoName: 'Website',
    worktreeName: 'main'
  }
}

describe('hand-archived conversations', () => {
  it.each([true, false])(
    'uses owner archive placement instead of a stale viewer mark: %s',
    (archived) => {
      const row = {
        ...session('peer', 'Remote work'),
        hostId: 'runtime:laptop' as const,
        ownerArchive: { archived, byHand: archived }
      }
      const tree = buildSessionSidebarTree({
        now,
        sessions: [row],
        metadata: emptySessionFolderMetadata(),
        view: { ...emptySessionSidebarView(), archived: archived ? [] : ['peer'] },
        archivedKeys: new Set(archived ? [] : ['peer']),
        snapshot: {
          cardsByPaneKey: new Map(),
          cardsByTabId: new Map(),
          attentionByPaneKey: new Map()
        },
        query: '',
        showHidden: false,
        showArchived: true
      })
      expect(
        tree.groups
          .find((group) => group.kind === 'archived')
          ?.rows.some((item) => item.session.rowKey === 'peer') ?? false
      ).toBe(archived)
    }
  )

  it('overrides every age-derived bucket without inventing a finish time', () => {
    const live = {
      now,
      state: 'working' as const,
      waitingUntil: null,
      attention: false,
      unavailable: false
    }
    expect(classifyConversation({ ...live, archived: true })).toEqual({
      group: 'archived',
      completed: null
    })
    expect(classifyConversation({ ...live, attention: true, archived: true }).group).toBe(
      'archived'
    )
    const finished = {
      ...live,
      state: 'done' as const,
      stateChangedAt: now - CONVERSATION_COMPLETED_AFTER_MS
    }
    // Why: the caption keeps what the row knows about its end — the real turn end, never a
    // manufactured plan receipt — so an archived finished row still says when it finished.
    expect(classifyConversation({ ...finished, archived: true })).toEqual({
      group: 'archived',
      completed: { reason: 'finished', at: now - CONVERSATION_COMPLETED_AFTER_MS }
    })
    expect(classifyConversation({ ...finished, archived: false }).group).toBe('completed')
    expect(
      classifyConversation({
        ...finished,
        stateChangedAt: now - CONVERSATION_ARCHIVED_AFTER_MS,
        archived: false
      }).group
    ).toBe('completed')
  })

  it('files a hidden row that is then archived under Archived, where it can be deleted', () => {
    const a = session('a', 'Alpha')
    const tree = buildSessionSidebarTree({
      now,
      sessions: [a],
      metadata: emptySessionFolderMetadata(),
      view: { ...emptySessionSidebarView(), hidden: ['conversation:a'] },
      snapshot: {
        cardsByPaneKey: new Map(),
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map()
      },
      query: '',
      showHidden: false,
      showArchived: true,
      archivedKeys: new Set(['a'])
    })
    expect(tree.groups.find((group) => group.kind === 'hidden')).toBeUndefined()
    expect(
      tree.groups.find((group) => group.kind === 'archived')!.rows.map((row) => row.session.label)
    ).toEqual(['Alpha'])
  })

  it('leaves a deleted conversation out of the list until its tab is open again', () => {
    const closed = { ...session('a', 'Alpha'), tabId: null, paneKey: null }
    const input = {
      now,
      sessions: [closed],
      metadata: emptySessionFolderMetadata(),
      view: { ...emptySessionSidebarView(), deleted: ['a'] },
      snapshot: {
        cardsByPaneKey: new Map(),
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map()
      },
      query: '',
      showHidden: true,
      showArchived: true
    }
    expect(buildSessionSidebarTree(input).totalRows).toBe(0)
    const reopened = { ...closed, tabId: 'tab-a', paneKey: 'tab-a:pane' }
    expect(buildSessionSidebarTree({ ...input, sessions: [reopened] }).totalRows).toBe(1)
  })

  it('puts a hand-archived working row under Archived and out of Conversations', () => {
    const a = session('a', 'Alpha')
    const b = session('b', 'Beta')
    const cards = new Map([
      [a.paneKey!, workingCard(a.paneKey!)],
      [b.paneKey!, workingCard(b.paneKey!)]
    ])
    const input = {
      now,
      sessions: [a, b],
      metadata: emptySessionFolderMetadata(),
      view: emptySessionSidebarView(),
      snapshot: {
        cardsByPaneKey: cards,
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map()
      },
      query: '',
      showHidden: false,
      archivedKeys: new Set(['a'])
    }
    const hidden = buildSessionSidebarTree({ ...input, showArchived: false })
    expect(hidden.archivedCount).toBe(1)
    expect(
      hidden.groups.map((group) => [group.kind, group.rows.map((row) => row.session.label)])
    ).toEqual([
      ['workspace', ['Beta']],
      ['saved', []]
    ])

    const shown = buildSessionSidebarTree({ ...input, showArchived: true })
    const archived = shown.groups.find((group) => group.kind === 'archived')!
    expect(archived.rows.map((row) => row.session.label)).toEqual(['Alpha'])
    expect(archived.rows[0]!.archived).toBe(true)
    expect(archived.rows[0]!.completed).toBeNull()
    // Why: the agent is still working; archiving is filing, not stopping.
    expect(archived.rows[0]!.state).toBe('working')

    const unarchived = buildSessionSidebarTree({
      ...input,
      archivedKeys: new Set()
    })
    expect(unarchived.archivedCount).toBe(0)
    expect(unarchived.groups[0]!.rows.map((row) => row.session.label)).toEqual(['Alpha', 'Beta'])
  })

  it('takes a saved conversation archived by hand out of Saved Sessions, and back on unarchive', () => {
    const a = session('a', 'Alpha')
    const input = {
      now,
      sessions: [a],
      metadata: { ...emptySessionFolderMetadata(), membership: { a: SAVED_SESSIONS_FOLDER_ID } },
      view: emptySessionSidebarView(),
      snapshot: {
        cardsByPaneKey: new Map(),
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map()
      },
      query: '',
      showHidden: false,
      showArchived: true
    }
    const labels = (kind: string, archivedKeys: Set<string>) =>
      buildSessionSidebarTree({ ...input, archivedKeys })
        .groups.filter((group) => group.kind === kind)
        .flatMap((group) => group.rows.map((row) => row.session.label))

    expect(labels('saved', new Set(['a']))).toEqual([])
    expect(labels('archived', new Set(['a']))).toEqual(['Alpha'])
    // Why: archiving never touched the folder, so unarchiving lands it where it was.
    expect(labels('saved', new Set())).toEqual(['Alpha'])
    expect(labels('archived', new Set())).toEqual([])
  })

  function planInput(chain: SessionChain, a: SidebarSession, archived: boolean) {
    return {
      now,
      sessions: [a],
      metadata: emptySessionFolderMetadata(),
      view: emptySessionSidebarView(),
      snapshot: {
        cardsByPaneKey: new Map(),
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map()
      },
      query: '',
      showHidden: false,
      chainByRowKey: new Map([[a.rowKey, chain]]),
      archivedKeys: new Set(archived ? ['a'] : [])
    }
  }

  function stalledPlan(a: SidebarSession): SessionChain {
    const chain = conversationPlanFixture()
    chain.sourceRowKey = a.rowKey
    chain.sourcePaneKey = a.paneKey!
    chain.outcomeSet!.attempts = []
    chain.outcomeSet!.outcomes[0]!.status = 'blocked'
    chain.outcomeSet!.outcomes[0]!.blockedReason = 'No activity was observed for 180s.'
    return chain
  }

  it('keeps a hand-archived row under Archived when its outcome plan fails, asking nothing', () => {
    // Why: a stopped plan used to reclassify the row into Needs you, so archiving never stuck.
    const a = session('a', 'Alpha')
    const input = planInput(stalledPlan(a), a, true)
    const hidden = buildSessionSidebarTree({ ...input, showArchived: false })
    expect(hidden.groups.map((group) => group.kind)).not.toContain('attention')
    expect(hidden.groups.flatMap((group) => group.rows)).toEqual([])
    expect(hidden.attentionCount).toBe(0)
    const shown = buildSessionSidebarTree({ ...input, showArchived: true })
    const archived = shown.groups.find((group) => group.kind === 'archived')!
    expect(archived.rows.map((row) => row.session.label)).toEqual(['Alpha'])
    // Why: the stall text is a diagnostic. The run failed; it never blocked on the person.
    expect(archived.rows[0]).toMatchObject({
      pursuitState: 'failed',
      planNeedsYou: false,
      attention: null,
      locked: null,
      run: { phase: 'failed', settled: true, countsAsAttention: false, requests: [] }
    })
    expect(shown.attentionCount).toBe(0)
  })

  it('shows no queue or attention projection on archived sealed, failed or cancelled runs', () => {
    const a = session('a', 'Alpha')
    const sealed = stalledPlan(a)
    sealed.outcomeSet!.completion = {
      at: now - 5_000,
      outcomes: [{ id: 'outcome', revision: 1 }],
      evidenceIds: []
    }
    sealed.outcomeSet!.continuation.state = 'unverifiable'
    const cancelled = stalledPlan(a)
    cancelled.state = 'cancelled'
    for (const chain of [sealed, stalledPlan(a), cancelled]) {
      const tree = buildSessionSidebarTree({ ...planInput(chain, a, true), showArchived: true })
      expect(tree.attentionCount).toBe(0)
      expect(tree.groups.map((group) => group.kind)).not.toContain('attention')
      const row = tree.groups.find((group) => group.kind === 'archived')!.rows[0]!
      expect(row).toMatchObject({
        archived: true,
        planNeedsYou: false,
        attention: null,
        locked: null
      })
      expect(row.run?.countsAsAttention ?? false).toBe(false)
    }
  })
})

describe("a paired owner's ledger archive mark (session parity, step 6, C3)", () => {
  type Mark = boolean | undefined

  /** A live mirror joined by its ledger record, the frame and the ledger arriving in `order`. */
  function joined(
    frame: Mark,
    ledger: Mark,
    order: 'frame-first' | 'ledger-first',
    ownerState: 'ready' | 'older' = 'ready'
  ) {
    const source = pairedSource()
    const tab = addMirrorTab(source)
    const steps = {
      frame: () => {
        if (frame !== undefined) {
          tab.runtimeOwnerArchiveByLeafId = {
            [SESSION_TEST_LEAF]: { archived: frame, byHand: frame }
          }
        }
      },
      ledger: () => {
        const record = ledgerRecord('s1', {
          paneKey: OWNER_PANE,
          ...(ledger === undefined ? {} : { archived: { archived: ledger } })
        })
        Object.assign(source, ledgerSlices([ledgerBucket([record], { ownerState })]))
      }
    }
    for (const step of order === 'frame-first' ? ['frame', 'ledger'] : ['ledger', 'frame']) {
      steps[step as keyof typeof steps]()
    }
    return buildSidebarSessions(source)
  }

  function archivedCount(sessions: SidebarSession[], localMarks: string[]): number {
    return buildSessionSidebarTree({
      now,
      sessions,
      metadata: emptySessionFolderMetadata(),
      view: { ...emptySessionSidebarView(), archived: localMarks },
      archivedKeys: new Set(localMarks),
      snapshot: {
        cardsByPaneKey: new Map(),
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map()
      },
      query: '',
      showHidden: false
    }).archivedCount
  }

  it.each<[Mark, Mark, number]>([
    [true, false, 0],
    [false, true, 1],
    [undefined, true, 1],
    [true, undefined, 1],
    [false, undefined, 0]
  ])(
    'frame %s, ledger %s: archived %i in both arrival orders, whatever was marked here',
    (frame, ledger, expected) => {
      for (const order of ['frame-first', 'ledger-first'] as const) {
        const sessions = joined(frame, ledger, order)
        expect(sessions).toHaveLength(1)
        const key = conversationViewKey(sessions[0]!)
        expect(archivedCount(sessions, [])).toBe(expected)
        expect(archivedCount(sessions, [key])).toBe(expected)
      }
    }
  )

  it('keeps this computer’s own mark while neither the owner’s frame nor its ledger says', () => {
    const sessions = joined(undefined, undefined, 'ledger-first')
    expect(archivedCount(sessions, [])).toBe(0)
    expect(archivedCount(sessions, [conversationViewKey(sessions[0]!)])).toBe(1)
  })

  // An owner that answered a fresh connection without a ledger keeps its buckets as `older`:
  // that frozen mark may be behind the owner's live frame (it archived X after turning older),
  // so the frame wins, and with no frame mark this computer's own mark stands, as before 1b.
  it.each<[Mark, Mark, number, number]>([
    [true, false, 1, 1],
    [false, true, 0, 0],
    [undefined, true, 0, 1],
    [undefined, false, 0, 1],
    [true, undefined, 1, 1]
  ])(
    'older owner — frame %s, ledger %s: archived %i unmarked here, %i marked here, in both orders',
    (frame, ledger, unmarked, marked) => {
      for (const order of ['frame-first', 'ledger-first'] as const) {
        const sessions = joined(frame, ledger, order, 'older')
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.mirroredConversation?.ownerState).toBe('older')
        expect(archivedCount(sessions, [])).toBe(unmarked)
        expect(archivedCount(sessions, [conversationViewKey(sessions[0]!)])).toBe(marked)
      }
    }
  )
})
