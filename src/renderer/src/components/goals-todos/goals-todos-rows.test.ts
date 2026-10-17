import { describe, expect, it } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import {
  buildGoalsTodosGroups,
  GOALS_TODOS_IDLE_SHOWN,
  GOALS_TODOS_MAX_AGE_MS,
  GOALS_TODOS_MAX_SESSIONS,
  goalsTodosHeading,
  selectGoalsTodosInputs,
  type GoalsTodosDetails,
  type GoalsTodosInput
} from './goals-todos-rows'

const NOW = 1_800_000_000_000

function session(rowKey: string, label = `Session ${rowKey}`): SidebarSession {
  return {
    rowKey,
    sessionKey: rowKey,
    worktreeId: 'wt',
    hostId: 'local',
    tabId: 'tab',
    paneKey: `tab:${rowKey}`,
    kind: 'terminal',
    label,
    workspaceLabel: 'Project A',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null
  }
}

function input(
  rowKey: string,
  state: 'working' | 'waiting' | 'blocked' | 'done' | null,
  updatedAt: number | null = NOW
): GoalsTodosInput {
  return {
    session: session(rowKey),
    status: state && updatedAt !== null ? { state, updatedAt } : null,
    updatedAt
  }
}

const neverUnnamed = (): boolean => false

describe('buildGoalsTodosGroups', () => {
  it('groups by whether the session needs the person', () => {
    const groups = buildGoalsTodosGroups({
      inputs: [
        input('a', 'waiting'),
        input('b', 'blocked'),
        input('c', 'working'),
        input('d', 'done'),
        input('e', null)
      ],
      details: new Map(),
      isUnnamed: neverUnnamed
    })
    expect(groups['needs-you'].map((row) => row.key)).toEqual(['a', 'b'])
    expect(groups['in-progress'].map((row) => row.key)).toEqual(['c'])
    expect(groups.idle.map((row) => row.key)).toEqual(['d', 'e'])
  })

  it('reports progress and the current step from the read list', () => {
    const details = new Map<string, GoalsTodosDetails>([
      [
        'a',
        {
          goal: { line: 'Ship it', full: 'Ship it' },
          todos: [
            { text: 'One', status: 'completed' },
            { text: 'Two', status: 'current' },
            { text: 'Three', status: 'pending' }
          ],
          source: 'text',
          lastMessageAt: NOW + 5
        }
      ]
    ])
    const [row] = buildGoalsTodosGroups({
      inputs: [input('a', 'working')],
      details,
      isUnnamed: neverUnnamed
    })['in-progress']
    expect(row).toMatchObject({
      completed: 1,
      total: 3,
      current: { text: 'Two', status: 'current' },
      source: 'text',
      goalLine: 'Ship it',
      updatedAt: NOW + 5
    })
  })

  it('keeps only the most recent finished sessions and says how many are left out', () => {
    const inputs = Array.from({ length: GOALS_TODOS_IDLE_SHOWN + 3 }, (_, index) =>
      input(`idle-${index}`, 'done')
    )
    const groups = buildGoalsTodosGroups({ inputs, details: new Map(), isUnnamed: neverUnnamed })
    expect(groups.idle).toHaveLength(GOALS_TODOS_IDLE_SHOWN)
    expect(groups.idleHidden).toBe(3)
  })
})

describe('goalsTodosHeading', () => {
  const goal = { line: 'Fix the login bug', full: 'Fix the login bug' }

  it('heads an unnamed session with its goal', () => {
    expect(goalsTodosHeading('Claude conversation', true, goal)).toEqual({
      heading: 'Fix the login bug',
      goalLine: null
    })
  })

  it('keeps a real name and shows the goal under it', () => {
    expect(goalsTodosHeading('Login work', false, goal)).toEqual({
      heading: 'Login work',
      goalLine: 'Fix the login bug'
    })
  })

  it('does not repeat a goal the name already says', () => {
    expect(goalsTodosHeading('fix the login  bug', false, goal).goalLine).toBeNull()
  })
})

describe('selectGoalsTodosInputs', () => {
  it('drops finished sessions older than the window but keeps live ones', () => {
    const old = NOW - GOALS_TODOS_MAX_AGE_MS - 1
    const selected = selectGoalsTodosInputs(
      [input('old-done', 'done', old), input('old-working', 'working', old), input('new', 'done')],
      NOW
    )
    expect(selected.map((item) => item.session.rowKey)).toEqual(['new', 'old-working'])
  })

  it('bounds the scan, newest first', () => {
    const inputs = Array.from({ length: GOALS_TODOS_MAX_SESSIONS + 10 }, (_, index) =>
      input(`s-${index}`, 'done', NOW - index)
    )
    const selected = selectGoalsTodosInputs(inputs, NOW)
    expect(selected).toHaveLength(GOALS_TODOS_MAX_SESSIONS)
    expect(selected[0]?.session.rowKey).toBe('s-0')
  })
})
