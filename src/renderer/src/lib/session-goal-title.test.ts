import { describe, expect, it } from 'vitest'
import { sessionGoalFromPrompt } from '../../../shared/session-goal'
import { junkCustomTitleRepairs, sessionDisplayTitle, sessionGoalTitle } from './session-goal-title'

const goal = sessionGoalFromPrompt(
  'Please fix the PDF export. Then check the Refer & Earn copy.\n<system-reminder>Use the repo rules.</system-reminder>'
)

const row = (label: string, customTitle?: string) => ({
  label,
  agent: 'claude',
  ...(customTitle === undefined ? {} : { customTitle })
})

describe('sessionGoalTitle', () => {
  it('is the goal’s first clause without the harness block', () => {
    expect(sessionGoalTitle(goal)).toBe('Fix the PDF export')
    expect(sessionGoalTitle(null)).toBeNull()
  })

  it('is capped like any generated title', () => {
    const long = sessionGoalFromPrompt(
      'Investigate why the nightly export job keeps timing out on large accounts'
    )
    expect(sessionGoalTitle(long)!.length).toBeLessThanOrEqual(40)
  })
})

describe('sessionDisplayTitle', () => {
  it('shows the goal for a junk title the app set', () => {
    expect(sessionDisplayTitle(row('worker-task_5ad8df40da3a'), goal)).toBe('Fix the PDF export')
    expect(sessionDisplayTitle(row('claude conversation'), goal)).toBe('Fix the PDF export')
    expect(sessionDisplayTitle(row('claude'), goal)).toBe('Fix the PDF export')
  })

  it('repairs known automatic scaffold labels from the retained first request', () => {
    for (const label of [
      'Launch context added by omni launch best',
      'Prepared launch brief',
      'SSH launch readiness mw0001 Requested',
      'Image 1 something is going seriously'
    ]) {
      expect(sessionDisplayTitle(row(label), goal)).toBe('Fix the PDF export')
      expect(sessionDisplayTitle(row(label, label), goal)).toBe(label)
      expect(sessionDisplayTitle(row(label), null)).toBe(label)
    }
  })

  it('keeps a good title', () => {
    expect(sessionDisplayTitle(row('Checkout redesign'), goal)).toBe('Checkout redesign')
  })

  it('keeps a junk title when there is no goal', () => {
    expect(sessionDisplayTitle(row('worker-task_5ad8df40da3a'), null)).toBe(
      'worker-task_5ad8df40da3a'
    )
    expect(sessionDisplayTitle(row('claude conversation'), undefined)).toBe('claude conversation')
  })

  it('never replaces a custom title, even a junk one', () => {
    expect(
      sessionDisplayTitle(row('worker-task_5ad8df40da3a', 'worker-task_5ad8df40da3a'), goal)
    ).toBe('worker-task_5ad8df40da3a')
    expect(sessionDisplayTitle(row('Mine', 'Mine'), goal)).toBe('Mine')
  })
})

describe('junkCustomTitleRepairs', () => {
  const goals = new Map([
    ['a', goal],
    ['b', goal],
    ['c', null],
    ['d', goal],
    ['e', goal]
  ])
  const sessions = [
    { ...row('worker-task_5ad8df40da3a', 'worker-task_5ad8df40da3a'), rowKey: 'a', tabId: 't1' },
    // Another pane of the same tab shares its title: one repair per tab.
    { ...row('worker-task_5ad8df40da3a', 'worker-task_5ad8df40da3a'), rowKey: 'b', tabId: 't1' },
    // No goal to rename from.
    { ...row('ssh-20260925', 'ssh-20260925'), rowKey: 'c', tabId: 't2' },
    // Junk, but the app's own title: shown as the goal already, never offered.
    { ...row('claude conversation'), rowKey: 'd', tabId: 't3' },
    // A good custom title.
    { ...row('Checkout redesign', 'Checkout redesign'), rowKey: 'e', tabId: 't4' },
    { ...row('Claude conversation', ' Claude conversation '), rowKey: 'd', tabId: 't5' }
  ]

  it('offers only junk custom titles that have a goal, once per tab, keeping the exact old title', () => {
    expect(junkCustomTitleRepairs(sessions, (session) => goals.get(session.rowKey))).toEqual([
      { tabId: 't1', previous: 'worker-task_5ad8df40da3a', next: 'Fix the PDF export' },
      { tabId: 't5', previous: ' Claude conversation ', next: 'Fix the PDF export' }
    ])
  })

  it('never offers a title the person chose, however it looks', () => {
    const session = {
      ...row('worker-task_5ad8df40da3a', 'worker-task_5ad8df40da3a'),
      rowKey: 'a',
      tabId: 't1'
    }
    expect(
      junkCustomTitleRepairs(
        [session],
        () => goal,
        () => 'yours'
      )
    ).toEqual([])
    expect(
      junkCustomTitleRepairs(
        [session],
        () => goal,
        () => 'generated'
      )
    ).toEqual([{ tabId: 't1', previous: 'worker-task_5ad8df40da3a', next: 'Fix the PDF export' }])
  })
})
