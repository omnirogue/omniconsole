import { expect, it } from 'vitest'
import {
  buildAgentPaneSnapshot,
  type AgentPaneCard
} from '@/components/attention/agent-pane-snapshot'
import {
  ATTENTION_FIXTURE_NOW,
  ATTENTION_FIXTURE_PANE_A,
  attentionFixtureEntry,
  attentionFixtureInputs
} from '@/components/attention/attention-test-fixtures'
import { GEMINI_IDLE } from '../../../shared/agent-title-core'
import { classifyConversation } from './conversation-retention'
import { conversationPlanFixture } from './conversation-plan-fixture'
import { dotStateForCard } from './session-pane-cards'
import { sessionRowIndicator } from '@/components/sidebar/session-folders/SessionSidebarRowIndicator'
import { sessionRowStatus } from '@/components/sidebar/session-folders/session-row-status'
import { buildSessionSidebarTreeRows } from './session-sidebar-tree-rows'
import { emptySessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'
import type { SidebarSession } from './sidebar-sessions'

const input = { now: 1000, waitingUntil: null, attention: false, unavailable: false }

it('reads an acknowledged turn as Done, finished, at any age', () => {
  for (const now of [1000, 1001, 100_000_000]) {
    expect(
      classifyConversation({
        ...input,
        now,
        state: 'idle',
        canonicalBucket: 'idle',
        stateChangedAt: 1000
      })
    ).toEqual({ group: 'completed', completed: { reason: 'finished', at: 1000 } })
  }
})

it('keeps background work in Waiting while a foreground turn stays Active', () => {
  const card = {
    bucket: 'working',
    dotState: 'working',
    workingMode: 'monitoring'
  } as AgentPaneCard
  const state = dotStateForCard(card)
  expect(state).toBe('monitoring')
  expect(classifyConversation({ ...input, state }).group).toBe('waiting')
  expect(
    classifyConversation({ ...input, state: dotStateForCard({ ...card, workingMode: undefined }) })
      .group
  ).toBe('conversations')
})

it('does not let a pending outcome conceal live source execution', () => {
  const chain = conversationPlanFixture()
  chain.outcomeSet!.attempts = []
  chain.outcomeSet!.continuation.sourceReady = false
  expect(classifyConversation({ ...input, chain, state: 'working', working: true }).group).toBe(
    'conversations'
  )
  expect(classifyConversation({ ...input, chain, state: 'done', working: false }).group).toBe(
    'waiting'
  )
})

it('keeps lost execution unverified, and lets the same session resume', () => {
  const stale = { bucket: 'idle', dotState: 'idle', activityUnverifiable: true } as AgentPaneCard
  expect(
    classifyConversation({ ...input, state: dotStateForCard(stale), unavailable: true }).group
  ).toBe('waiting')
  expect(classifyConversation({ ...input, state: 'working', working: true }).group).toBe(
    'conversations'
  )
  expect(classifyConversation({ ...input, state: 'done' }).group).toBe('completed')
})

it('shows orange waiting without a pulse and no activity mark on Done', () => {
  const base = { needsYou: false, waitingUntil: null, locked: null, chain: null, launchedBy: null }
  expect(sessionRowIndicator({ ...base, visualState: 'awaiting' })).toBe('waiting')
  expect(sessionRowIndicator({ ...base, visualState: 'working' })).toBe('running')
  expect(sessionRowIndicator({ ...base, visualState: 'done' })).toBeNull()
})

it('keeps an unavailable idle observation in Waiting, and a finished one Done', () => {
  // Why: a lost host may still be running the idle pane, so the row waits for the host; a turn
  // the agent itself reported finished is Done wherever the host is now.
  expect(classifyConversation({ ...input, state: 'idle', unavailable: true }).group).toBe('waiting')
  expect(classifyConversation({ ...input, state: 'done', unavailable: true }).group).toBe(
    'completed'
  )
  expect(classifyConversation({ ...input, state: 'failed', unavailable: true }).group).toBe(
    'stopped'
  )
})

it('keeps a reserved launch Waiting while provider availability is being checked', () => {
  expect(classifyConversation({ ...input, state: null, launchPending: true }).group).toBe('waiting')
})

it.each([
  ['missing', 'waiting', 'unverifiable'],
  ['snoozed', 'waiting', 'waiting'],
  ['restored', 'waiting', 'unverifiable'],
  ['done', 'completed', 'done'],
  ['title-idle', 'completed', 'inactive']
] as const)(
  'projects %s evidence through the pane snapshot and sidebar',
  (evidence, group, visual) => {
    const inputs = attentionFixtureInputs()
    if (evidence === 'restored' || evidence === 'done') {
      inputs.agentStatusByPaneKey[ATTENTION_FIXTURE_PANE_A] = attentionFixtureEntry(
        ATTENTION_FIXTURE_PANE_A,
        'tab-a',
        'w1',
        evidence === 'restored' ? { restoredUnconfirmed: true } : { state: 'done' }
      )
    }
    if (evidence === 'title-idle') {
      inputs.runtimePaneTitlesByTabId = { 'tab-a': { 1: `${GEMINI_IDLE} Gemini CLI` } }
    }
    const session: SidebarSession = {
      rowKey: 'row',
      sessionKey: 'session',
      worktreeId: 'w1',
      hostId: 'local',
      tabId: 'tab-a',
      paneKey: ATTENTION_FIXTURE_PANE_A,
      kind: 'terminal',
      label: 'Conversation',
      workspaceLabel: 'Workspace',
      agent: 'claude',
      unavailable: false,
      folderKeyMigration: null
    }
    const snapshot = buildAgentPaneSnapshot(inputs, ATTENTION_FIXTURE_NOW)
    if (evidence === 'missing' || evidence === 'snoozed') {
      expect(snapshot.cards).toEqual([])
    }
    const until = new Date(ATTENTION_FIXTURE_NOW + 3_600_000).toISOString()
    const result = buildSessionSidebarTreeRows(
      {
        sessions: [session],
        snapshot,
        metadata: emptySessionFolderMetadata(),
        view: emptySessionSidebarView(),
        waitingUntilByPaneKey:
          evidence === 'snoozed' ? new Map([[session.paneKey!, until]]) : undefined,
        query: '',
        showHidden: false
      },
      ATTENTION_FIXTURE_NOW
    )
    expect(result.classifications.get('row')).toBe(group)
    const row = result.rows[0]!
    expect(row.pursuitState).toBe(visual)
    if (evidence === 'snoozed') {
      expect(row.completed).toBeNull()
      expect(row.activityUnverifiable).toBeFalsy()
      expect(
        sessionRowStatus({
          ...row,
          chain: null,
          pursuitChain: null,
          run: null,
          completed: null,
          returned: false,
          queued: false,
          archived: false,
          locked: null,
          now: ATTENTION_FIXTURE_NOW
        })
      ).toMatchObject({ kind: 'snoozed', until })
    } else if (group === 'waiting') {
      expect(row.completed).toBeNull()
      expect(row.activityUnverifiable).toBe(true)
      expect(
        sessionRowStatus({
          ...row,
          chain: null,
          pursuitChain: null,
          run: null,
          completed: row.completed ?? null,
          returned: false,
          queued: false,
          archived: false,
          locked: null
        })
      ).toMatchObject({ kind: 'awaiting', text: 'Execution unverified · waiting for the host' })
    } else {
      expect(row.completed?.reason).toBe('finished')
      expect(row.activityUnverifiable).toBeFalsy()
    }
  }
)
