import { describe, expect, it, vi } from 'vitest'
import { buildAgentPaneSnapshot } from '@/components/attention/agent-pane-snapshot'
import {
  ATTENTION_FIXTURE_NOW,
  ATTENTION_FIXTURE_PANE_A,
  attentionFixtureEntry,
  attentionFixtureInputs
} from '@/components/attention/attention-test-fixtures'
import { sessionRowStatus } from '@/components/sidebar/session-folders/session-row-status'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import { createHookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { emptySessionFolderMetadata } from './session-folders'
import { buildSessionSidebarTree, SESSION_WAITING_GROUP_KEY } from './session-sidebar-tree'
import { emptySessionSidebarView } from './session-sidebar-view'
import type { SidebarSession } from './sidebar-sessions'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

const session: SidebarSession = {
  rowKey: 'row-a',
  sessionKey: 'session-a',
  worktreeId: 'w1',
  hostId: 'local',
  tabId: 'tab-a',
  paneKey: ATTENTION_FIXTURE_PANE_A,
  kind: 'terminal',
  label: 'Watch the build',
  workspaceLabel: 'Repo One / wt-one',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

/** The real listener's answer to "Crunched · done · 2 shells still running". */
function finishedTurnWithTwoShells() {
  const listener = createHookListenerState()
  const claude = (payload: object) =>
    normalizeHookPayload(
      listener,
      'claude',
      { paneKey: ATTENTION_FIXTURE_PANE_A, payload },
      'production'
    )?.payload
  claude({ hook_event_name: 'UserPromptSubmit', prompt: 'start the watchers' })
  const payload = claude({
    hook_event_name: 'Stop',
    background_tasks: [
      { id: 'b1', type: 'shell', status: 'running', command: 'pnpm dev' },
      { id: 'b2', type: 'shell', status: 'running', command: 'pnpm test --watch' }
    ]
  })
  if (!payload) {
    throw new Error('listener produced no payload')
  }
  return payload
}

function sidebarFor(payload: ReturnType<typeof finishedTurnWithTwoShells>) {
  const entry = attentionFixtureEntry(ATTENTION_FIXTURE_PANE_A, 'tab-a', 'w1', {
    state: payload.state,
    workingMode: payload.workingMode,
    backgroundTaskCount: payload.backgroundTaskCount
  })
  const snapshot = buildAgentPaneSnapshot(
    attentionFixtureInputs({ agentStatusByPaneKey: { [ATTENTION_FIXTURE_PANE_A]: entry } }),
    ATTENTION_FIXTURE_NOW
  )
  return buildSessionSidebarTree({
    now: ATTENTION_FIXTURE_NOW,
    sessions: [session],
    metadata: emptySessionFolderMetadata(),
    view: emptySessionSidebarView(),
    snapshot,
    query: '',
    showHidden: false
  })
}

describe('a finished turn with live background work in the Conversations sidebar', () => {
  it('lists the row under Waiting, never Active, saying it waits on 2 background tasks', () => {
    const tree = sidebarFor(finishedTurnWithTwoShells())

    const waiting = tree.groups.find((group) => group.key === SESSION_WAITING_GROUP_KEY)
    expect(waiting?.rows.map((row) => row.session.rowKey)).toEqual(['row-a'])
    expect(
      tree.groups.filter((group) => group.key !== SESSION_WAITING_GROUP_KEY && group.rows.length)
    ).toEqual([])
    const row = waiting!.rows[0]!
    expect(row).toMatchObject({ state: 'monitoring', backgroundTaskCount: 2 })
    expect(
      sessionRowStatus({
        monitoring: row.state === 'monitoring',
        backgroundTaskCount: row.backgroundTaskCount,
        session,
        chain: null,
        pursuitChain: null,
        run: null,
        attention: null,
        returned: false,
        waitingUntil: null,
        locked: null,
        queued: false,
        completed: null,
        archived: false
      })
    ).toEqual({ kind: 'awaiting', text: 'Waiting on background work (2)' })
  })

  it('drops the number when the provider gave no count', () => {
    const payload = finishedTurnWithTwoShells()
    const tree = sidebarFor({ ...payload, backgroundTaskCount: undefined })
    const row = tree.groups.find((group) => group.key === SESSION_WAITING_GROUP_KEY)!.rows[0]!
    expect(row.backgroundTaskCount).toBeUndefined()
    expect(
      sessionRowStatus({
        monitoring: true,
        session,
        chain: null,
        pursuitChain: null,
        run: null,
        attention: null,
        returned: false,
        waitingUntil: null,
        locked: null,
        queued: false,
        completed: null,
        archived: false
      })?.text
    ).toBe('Waiting on background work')
  })
})
