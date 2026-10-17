import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  SessionRowHoverCardView,
  type SessionRowHoverCardViewProps
} from './SessionRowHoverCardView'

const base: SessionRowHoverCardViewProps = {
  title: 'Ship the hover card',
  agent: 'claude',
  model: 'opus',
  stateLabel: 'working',
  hostLabel: 'This device',
  team: {
    members: [
      {
        key: 'a',
        agent: 'codex',
        model: 'gpt-5',
        effort: 'high',
        role: 'producer',
        state: 'working',
        label: 'Build',
        group: null,
        round: null,
        placement: 'local'
      },
      {
        key: 'b',
        agent: 'claude',
        model: 'opus',
        effort: null,
        role: 'reviewer',
        state: 'planned',
        label: null,
        group: 'review',
        round: { index: 1, total: 3 },
        placement: 'fleet:mw0003'
      }
    ],
    plannedCount: 1,
    liveCount: 1,
    runningSeats: 1,
    capacity: { limit: 3, cardBound: false, label: 'up to 3 at a time' },
    parallelGroups: 1,
    sequentialCount: 1,
    reviewerSeats: 1,
    maxRounds: 3,
    placements: ['local', 'fleet:mw0003']
  },
  worktrees: [
    {
      id: 'repo::feat',
      name: 'feat',
      branch: 'feat/x',
      path: '/r/feat',
      relation: 'created',
      folder: false
    },
    { id: 'folder:fw', name: 'Designs', branch: null, path: '/d', relation: 'own', folder: true }
  ],
  capabilities: {
    host: 'local',
    providers: [{ provider: 'openrouter', envNames: ['OPENROUTER_API_KEY'] }],
    mcpServers: [{ name: 'github', source: 'Workspace' }],
    probedAt: 1
  },
  linkedLine: 'Orchestration visibility'
}

describe('SessionRowHoverCardView', () => {
  it('puts the compact work description before team and tool details', () => {
    const markup = renderToStaticMarkup(
      <SessionRowHoverCardView
        {...base}
        context={{
          goal: 'Recover failed checkouts',
          latestRequest: 'Handle provider timeouts as well',
          latestUpdate: 'Added bounded retries',
          nextStep: 'Verify the timeout path'
        }}
      />
    )
    for (const text of [
      'Recover failed checkouts',
      'Handle provider timeouts as well',
      'Added bounded retries',
      'Verify the timeout path'
    ]) {
      expect(markup).toContain(text)
      expect(markup.indexOf(text)).toBeLessThan(markup.indexOf('2 agents'))
    }
  })

  it('shows a request once when it is already the goal', () => {
    const markup = renderToStaticMarkup(
      <SessionRowHoverCardView
        {...base}
        context={{
          goal: 'Recover failed checkouts',
          latestRequest: 'Recover failed checkouts',
          latestUpdate: null,
          nextStep: null
        }}
      />
    )
    expect(markup.split('Recover failed checkouts')).toHaveLength(2)
  })

  it('renders absent context like an older reader that has no summary field', () => {
    const without = renderToStaticMarkup(<SessionRowHoverCardView {...base} />)
    const empty = renderToStaticMarkup(
      <SessionRowHoverCardView
        {...base}
        context={{ goal: null, latestRequest: null, latestUpdate: null, nextStep: null }}
      />
    )
    expect(empty).toBe(without)
  })

  it('renders header, team with roles and markers, worktrees and tool chips', () => {
    const markup = renderToStaticMarkup(<SessionRowHoverCardView {...base} />)
    expect(markup).toContain('Ship the hover card')
    expect(markup).toContain('claude · opus · working · This device')
    expect(markup).toContain('2 agents')
    expect(markup).toContain('1 reviewer seats')
    expect(markup).toContain('data-team-member="reviewer"')
    expect(markup).toContain('round 1/3')
    expect(markup).toContain('∥ review')
    expect(markup).toContain('fleet:mw0003')
    expect(markup).toContain('feat/x')
    expect(markup).toContain('data-worktree-relation="own"')
    expect(markup).toContain('OpenRouter')
    expect(markup).toContain('github')
    expect(markup).toContain('Orchestration visibility')
    expect(markup).not.toContain('OPENROUTER_API_KEY=')
    expect(markup).not.toContain('data-capabilities-unknown')
  })

  it('names skipped and failed seats, and gives a failed one a destructive tone', () => {
    const markup = renderToStaticMarkup(
      <SessionRowHoverCardView
        {...base}
        team={{
          ...base.team,
          members: [
            { ...base.team.members[0]!, key: 'skipped', state: 'skipped' },
            { ...base.team.members[1]!, key: 'failed', state: 'failed' }
          ],
          plannedCount: 0,
          liveCount: 0
        }}
      />
    )
    expect(markup).toContain('data-team-member-state="skipped"')
    expect(markup).toContain('skipped')
    expect(markup).toContain('text-destructive')
    expect(markup).toContain('failed')
    expect(markup).not.toContain('planned')
  })

  it('names a cancelled seat and keeps the destructive tone for failure alone', () => {
    const markup = renderToStaticMarkup(
      <SessionRowHoverCardView
        {...base}
        team={{
          ...base.team,
          members: [{ ...base.team.members[1]!, key: 'cancelled', state: 'cancelled' }],
          plannedCount: 0,
          liveCount: 0
        }}
      />
    )
    expect(markup).toContain('data-team-member-state="cancelled"')
    expect(markup).toContain('cancelled')
    expect(markup).not.toContain('text-destructive')
    expect(markup).not.toContain('planned')
  })

  it('says unknown for remote sessions and solo for no team', () => {
    const markup = renderToStaticMarkup(
      <SessionRowHoverCardView
        {...base}
        team={{
          ...base.team,
          members: [],
          plannedCount: 0,
          liveCount: 0,
          runningSeats: 0,
          parallelGroups: 0,
          reviewerSeats: 0,
          maxRounds: null,
          placements: []
        }}
        worktrees={[]}
        capabilities={{ host: 'remote', providers: 'unknown', mcpServers: 'unknown', probedAt: 1 }}
        linkedLine={null}
      />
    )
    expect(markup).toContain('data-capabilities-unknown')
    expect(markup).toContain('Working alone')
    expect(markup).not.toContain('data-session-linked')
  })
})
