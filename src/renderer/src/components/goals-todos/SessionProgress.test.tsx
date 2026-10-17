// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionGoalGroup } from '../../../../shared/session-goal-groups'
import type { SessionMilestone } from '../../../../shared/session-milestones'
import { goalHeadline, SessionGoalProgress, SessionProgressRows } from './SessionProgress'

afterEach(cleanup)

function rows(): { kind: string | null; status: string | null; text: string }[] {
  return [...document.querySelectorAll('[data-session-milestone]')].map((row) => ({
    kind: row.getAttribute('data-session-milestone'),
    status: row.getAttribute('data-session-milestone-status'),
    text: row.textContent ?? ''
  }))
}

describe('SessionProgressRows', () => {
  it('reads as plain milestones, with the blocked PRs named', () => {
    const milestones: SessionMilestone[] = [
      {
        key: 'built',
        kind: 'built',
        status: 'done',
        pullRequests: [1002, 1003, 1007, 1008],
        drafts: 4
      },
      { key: 'checks', kind: 'checks', status: 'fail', pullRequests: [1007, 1008] },
      { key: 'approved', kind: 'approved', status: 'todo' },
      {
        key: 'live:prod-omnirogue',
        kind: 'live',
        status: 'todo',
        target: 'OmniRogue',
        live: 0,
        total: 2,
        url: null
      },
      {
        key: 'live:prod-betacorp',
        kind: 'live',
        status: 'now',
        target: 'BetaCorp',
        live: 0,
        total: 2,
        url: null
      }
    ]
    render(<SessionProgressRows milestones={milestones} />)
    expect(rows()).toEqual([
      { kind: 'built', status: 'done', text: 'Prototype built4 draft PRs' },
      { kind: 'checks', status: 'fail', text: 'Checks#1007, #1008 failing' },
      { kind: 'approved', status: 'todo', text: 'Approved' },
      { kind: 'live', status: 'todo', text: 'Live on OmniRogue' },
      { kind: 'live', status: 'now', text: 'Live on BetaCorp' + 'deploying' }
    ])
    expect(
      document.querySelector('[data-session-milestone-mark="done"]')!.getAttribute('aria-label')
    ).toBe('Done')
    expect(
      document.querySelector('[data-session-milestone-mark="fail"]')!.getAttribute('aria-label')
    ).toBe('Blocked')
  })

  it('says who is waiting and how much is live', () => {
    render(
      <SessionProgressRows
        milestones={[
          { key: 'built', kind: 'built', status: 'done', pullRequests: [7], drafts: 0 },
          { key: 'approved', kind: 'approved', status: 'you' },
          {
            key: 'live:prod-omnirogue',
            kind: 'live',
            status: 'now',
            target: 'OmniRogue',
            live: 1,
            total: 2,
            url: null
          },
          {
            key: 'live:prod-betacorp',
            kind: 'live',
            status: 'fail',
            target: 'BetaCorp',
            live: 0,
            total: 1,
            url: 'https://ci/1'
          }
        ]}
      />
    )
    expect(rows().map((row) => row.text)).toEqual([
      'Prototype built#7',
      '!Approvedwaiting on you',
      'Live on OmniRogue1 of 2 live',
      'Live on BetaCorpdeploy failed'
    ])
  })
})

function group(title: string, milestones: SessionMilestone[]): SessionGoalGroup {
  return {
    key: title,
    title,
    pullRequests: [],
    milestones,
    done: milestones.every((milestone) => milestone.status === 'done')
  }
}

const shippedToggle = group('Publish unlimited toggle upgrade', [
  { key: 'built', kind: 'built', status: 'done', pullRequests: [870, 871], drafts: 0 },
  { key: 'approved', kind: 'approved', status: 'done' },
  {
    key: 'live:a',
    kind: 'live',
    status: 'done',
    target: 'OmniRogue',
    live: 1,
    total: 1,
    url: null
  },
  { key: 'live:b', kind: 'live', status: 'done', target: 'BetaCorp', live: 1, total: 1, url: null }
])
const newPrototype = group('Combine generation settings in one popover', [
  { key: 'built', kind: 'built', status: 'done', pullRequests: [1002], drafts: 1 },
  { key: 'approved', kind: 'approved', status: 'todo' },
  { key: 'live:a', kind: 'live', status: 'todo', target: 'OmniRogue', live: 0, total: 1, url: null }
])

describe('SessionGoalProgress', () => {
  it('folds a finished goal to one green line and opens the current one', () => {
    render(<SessionGoalProgress groups={[shippedToggle, newPrototype]} />)
    const earlier = document.querySelector('[data-session-goal="done"]')!
    expect(earlier.querySelector('summary')!.textContent).toBe(
      'Publish unlimited toggle upgradeLive on OmniRogue & BetaCorp'
    )
    expect(earlier.querySelector('[data-session-milestone-mark="done"]')).toBeTruthy()
    expect((earlier as HTMLDetailsElement).open).toBe(false)
    const current = document.querySelector('[data-session-goal="current"]')!
    expect(current.textContent).toContain('Combine generation settings in one popover')
    expect(current.querySelectorAll('[data-session-milestone]')).toHaveLength(3)
  })

  it('shows one goal as its rows alone, with Approve for the person', () => {
    const onApprove = vi.fn()
    render(<SessionGoalProgress groups={[newPrototype]} onApprove={onApprove} />)
    expect(document.querySelector('[data-session-goals]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprove).toHaveBeenCalledWith(newPrototype)
  })

  it('offers no Approve once approved', () => {
    render(<SessionGoalProgress groups={[shippedToggle]} onApprove={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })
})

describe('goalHeadline', () => {
  it('names the first unfinished milestone, or where the goal went live', () => {
    expect(goalHeadline(shippedToggle)).toEqual({
      text: 'Live on OmniRogue & BetaCorp',
      status: 'done'
    })
    expect(goalHeadline(newPrototype)).toEqual({ text: 'Next: your approval', status: 'todo' })
    expect(
      goalHeadline(
        group('x', [
          { key: 'built', kind: 'built', status: 'done', pullRequests: [1], drafts: 1 },
          { key: 'checks', kind: 'checks', status: 'fail', pullRequests: [1007, 1008] }
        ])
      )
    ).toEqual({ text: 'Checks · #1007, #1008 failing', status: 'fail' })
  })
})
