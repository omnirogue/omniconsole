import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverDecisionStats } from './discover-omnios-decision-stats'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function pages(runs: Record<string, { template: string; picks: [string, string, object?][] }>) {
  const root = mkdtempSync(join(tmpdir(), 'discover-decisions-'))
  roots.push(root)
  for (const [id, { template, picks }] of Object.entries(runs)) {
    mkdirSync(join(root, id))
    writeFileSync(join(root, id, 'findings.json'), JSON.stringify({ template, findings: [] }))
    writeFileSync(
      join(root, id, 'decisions.json'),
      JSON.stringify({
        version: 1,
        decisions: picks.map(([pick, at, receipt], index) => ({
          n: index + 1,
          key: `find.r1.${index + 1}`,
          title: 'T',
          pick,
          at,
          ...(receipt ? { receipt } : {})
        }))
      })
    )
  }
  return root
}

describe('Discover decisions in workflow stats', () => {
  const root = () =>
    pages({
      'run-a': {
        template: 'discover',
        picks: [
          ['start', '2026-10-15T10:00:00.000Z', { operationId: 'op', terminal: 'term' }],
          ['start', '2026-10-15T10:00:00.000Z'],
          ['not-now', '2026-10-15T10:00:00.000Z']
        ]
      },
      'run-b': {
        template: 'quick-discover',
        picks: [
          ['dig', '2026-10-16T10:00:00.000Z', { executionId: 'dug' }],
          ['not-now', '2026-10-16T10:00:00.000Z']
        ]
      }
    })

  it('sums the picks and the acted-on rate, with launches by receipt', () => {
    expect(discoverDecisionStats(root(), {})).toEqual({
      runs: 2,
      picks: { start: 2, dig: 1, notNow: 2 },
      launched: 2,
      actedOnRate: 3 / 5
    })
  })

  it('applies the template and since filters, and says unknown with nothing recorded', () => {
    const pagesRoot = root()
    expect(discoverDecisionStats(pagesRoot, { template: 'quick-discover' })).toMatchObject({
      runs: 1,
      picks: { start: 0, dig: 1, notNow: 1 }
    })
    expect(
      discoverDecisionStats(pagesRoot, { since: Date.parse('2026-10-16T00:00:00.000Z') })
    ).toMatchObject({ runs: 1, actedOnRate: 1 / 2 })
    expect(discoverDecisionStats(join(pagesRoot, 'missing'), {})).toEqual({
      runs: 0,
      picks: { start: 0, dig: 0, notNow: 0 },
      launched: 0,
      actedOnRate: 'unknown'
    })
  })
})
