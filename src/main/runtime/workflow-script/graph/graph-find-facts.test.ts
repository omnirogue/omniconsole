import { describe, expect, it } from 'vitest'
import type { WorkflowRoute, WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowSetFind } from '../../../../shared/workflow-graph-find'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import type { GraphCall } from './graph-plan-types'
import { drive, text } from './graph-test-harness'

const ROUTES: WorkflowRoute[] = ['claude', 'codex']

function find(items: string[]): WorkflowSpec {
  return workflowSetFind(workflowTemplate('find', ROUTES), { items, top: 2 }, ROUTES)
}

const REPOS = [
  'timgit/pg-boss — Postgres queue',
  'graphile/worker — Postgres queue',
  'tembo-io/pgmq — queue extension',
  'gone/away — renamed long ago'
]

function answer(facts: (call: GraphCall) => unknown) {
  return (call: GraphCall) => {
    if (call.facts) {
      return facts(call)
    }
    if (call.screen) {
      return {
        markdown: 'screen',
        scores: Object.fromEntries(
          call.screen.candidates.map((candidate, index) => [candidate.id, 3 - index * 0.5])
        ),
        criteria: [],
        unscored: []
      }
    }
    if (call.jev) {
      return text(
        `FINAL RANKING:\n${call.jev.candidates.map((entry, index) => `${index + 1}. ${entry.label}`).join('\n')}`
      )
    }
    return undefined
  }
}

describe("Find the best on GitHub's facts", () => {
  it('fetches the facts for a list of repositories first, and every judge reads them', () => {
    const plan = drive(
      find(REPOS),
      answer((call) => ({
        markdown: 'facts',
        facts: Object.fromEntries(
          call
            .facts!.repos.filter((repo) => repo.owner !== 'gone')
            .map((repo) => [repo.key, `GitHub facts for ${repo.owner}/${repo.repo}: 100 stars`])
        ),
        failed: [{ key: 'list.4', reason: 'not found on GitHub' }]
      }))
    )
    const facts = plan.calls.find((call) => call.facts)!
    expect(facts.facts!.repos.map((repo) => `${repo.owner}/${repo.repo}`)).toEqual([
      'timgit/pg-boss',
      'graphile/worker',
      'tembo-io/pgmq',
      'gone/away'
    ])
    const screen = plan.calls.find((call) => call.screen)!
    expect(screen.dependencies).toContain(facts.id)
    expect(screen.screen!.candidates[0]!.text).toBe(
      'timgit/pg-boss — Postgres queue\nGitHub facts for timgit/pg-boss: 100 stars'
    )
    expect(plan.calls.find((call) => call.jev)!.jev!.candidates[0]!.markdown).toContain(
      'GitHub facts for timgit/pg-boss'
    )
    expect(plan.find).toMatchObject({
      stage: 'done',
      facts: { repos: 4, fetched: 3, failed: ['gone/away (not found on GitHub)'] }
    })
    expect(plan.find!.rows!.find((row) => row.key === 'list.1')!.facts).toContain('100 stars')
    expect(plan.outcome!.final!.markdown).toContain(
      "GitHub's facts (stars, forks, last push, license…) were fetched for 3 of 4 repositories"
    )
    expect(plan.outcome!.gaps).toContain(
      'GitHub facts could not be fetched for 1 repository: gone/away (not found on GitHub).'
    )
  })

  it('goes on without them, and says so, when GitHub cannot be asked at all', () => {
    const plan = drive(
      find(REPOS),
      answer(() => ({
        markdown: 'none',
        facts: {},
        failed: [],
        error: 'the GitHub CLI (gh) is not installed'
      }))
    )
    expect(plan.find).toMatchObject({ stage: 'done' })
    expect(plan.calls.find((call) => call.screen)!.screen!.candidates[0]!.text).toBe(
      'timgit/pg-boss — Postgres queue'
    )
    expect(plan.outcome!.gaps.join(' ')).toContain(
      'GitHub facts were not fetched (the GitHub CLI (gh) is not installed)'
    )
  })

  it('replays a run admitted before GitHub facts exactly as it ran, without them', () => {
    const plan = drive(
      find(REPOS),
      answer(() => ({ markdown: 'x', facts: {}, failed: [] })),
      { findRules: undefined }
    )
    expect(plan.calls.some((call) => call.facts)).toBe(false)
    expect(plan.find).toMatchObject({ stage: 'done' })
    expect(plan.find!.facts).toBeUndefined()
  })

  it('asks GitHub nothing for a list that is not of repositories', () => {
    const plan = drive(
      find(['Jobs and/or events', 'A bakery', 'A bike shop', 'owner/repo — the odd one']),
      answer(() => ({ markdown: 'x', facts: {}, failed: [] }))
    )
    expect(plan.calls.some((call) => call.facts)).toBe(false)
    expect(plan.find!.facts).toBeUndefined()
  })
})
