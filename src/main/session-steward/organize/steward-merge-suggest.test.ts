import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureStewardSwitches } from '../steward-switches'
import { stewardMergeAcceptor, type StewardConsolidate } from './steward-merge-suggest'
import { runStewardOrganizePass } from './steward-organize-pass'
import { folder, organizeHarness, organizeRow } from './steward-organize-test-fixtures'
import {
  acceptStewardSuggestion,
  registerStewardSuggestionAcceptor
} from './steward-suggestion-accept'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()!()
  }
})

async function twoSessions(duplicate: number, patch: Parameters<typeof organizeRow>[1] = {}) {
  const rows = [
    organizeRow(
      1,
      { title: 'Billing export', ...patch },
      { title: 'Billing export', lastActivityAt: 10 }
    ),
    organizeRow(
      2,
      { title: 'Export invoices', ...patch },
      { title: 'Export invoices', lastActivityAt: 20 }
    )
  ]
  const h = await organizeHarness(rows, [folder('f', 'Ads')], {
    folder: () => ({ failed: 'not asked here' })
  })
  cleanups.push(h.cleanup)
  h.modes.refile = 'off'
  h.modes.retitle = 'off'
  let reads = 0
  h.deps.decide = async (request) => {
    reads += 1
    return {
      provider: 't',
      model: 't',
      usage: { inputTokens: 0, outputTokens: 0 },
      answers: request.questions.duplicate
        ? { duplicate: { type: 'noul' as const, noul: duplicate } }
        : ({} as Record<string, never>)
    }
  }
  return Object.assign(h, { reads: () => reads })
}

describe('merge suggestions', () => {
  it('suggests exactly one merge for two idle sessions doing the same work', async () => {
    const h = await twoSessions(0.92)
    const first = await runStewardOrganizePass(h.deps)
    expect(first.merges).toHaveLength(1)
    const [suggestion] = await h.suggestions.open('merge')
    expect(suggestion).toMatchObject({
      title: 'Merge “Billing export” into “Export invoices”?',
      evidence: 'Same deliverable (0.92 both ways)',
      proposal: { from: { sessionKey: 'view-1' }, into: { sessionKey: 'view-2' } }
    })
    await runStewardOrganizePass(h.deps)
    expect(await h.suggestions.open('merge')).toHaveLength(1)
    // Both orders were asked once; the second pass reused the answer.
    expect(h.reads()).toBe(2)
  })

  it('takes shared files as evidence without asking JEV, and nothing below 0.8', async () => {
    const shared = await twoSessions(0.1)
    shared.shared.set('view-1|view-2', ['src/billing.ts', 'src/export.ts'])
    await runStewardOrganizePass(shared.deps)
    expect((await shared.suggestions.open('merge'))[0]?.evidence).toBe('2 shared files')
    expect(shared.reads()).toBe(0)

    const different = await twoSessions(0.7)
    expect((await runStewardOrganizePass(different.deps)).merges).toEqual([])
  })

  it('never pairs independent sessions, other repos, or a dismissed pair', async () => {
    const independent = await twoSessions(0.95)
    independent.setOrigins({
      folders: {},
      sessions: { 'view-1': { batchId: 'b', index: 0, independent: true, at: 1 } }
    })
    expect((await runStewardOrganizePass(independent.deps)).merges).toEqual([])

    const apart = await twoSessions(0.95)
    apart.rows[1]!.row = { ...apart.rows[1]!.row, repoId: 'other', folder: null }
    expect((await runStewardOrganizePass(apart.deps)).merges).toEqual([])

    const dismissed = await twoSessions(0.95)
    await runStewardOrganizePass(dismissed.deps)
    const [open] = await dismissed.suggestions.open('merge')
    await dismissed.suggestions.dismiss(open!.id)
    dismissed.advance(4 * 24 * 60 * 60 * 1000)
    expect((await runStewardOrganizePass(dismissed.deps)).merges).toEqual([])
  })

  it('never pairs a session the person tagged independent, until the tag is removed', async () => {
    const h = await twoSessions(0.95)
    const tag = (kind: 'tag' | 'untag') =>
      h.record({
        kind,
        targets: [{ sessionKey: 'view-2' }],
        value: 'independent',
        executor: { kind: 'cli' },
        reason: 'separate reviewer'
      })
    tag('tag')
    expect((await runStewardOrganizePass(h.deps)).merges).toEqual([])
    expect(h.reads()).toBe(0)
    tag('untag')
    expect((await runStewardOrganizePass(h.deps)).merges).toHaveLength(1)
  })

  it('never pairs a session nobody has asked anything, or one a steward question opened', async () => {
    for (const goal of [
      null,
      '[Question q-d26a02e4 from Session steward — answer only, change nothing] Write a handoff'
    ]) {
      const h = await twoSessions(0.95)
      h.deps.goal = async (observed) =>
        observed.row.viewKey === 'view-1' ? goal : 'Export invoices'
      expect((await runStewardOrganizePass(h.deps)).merges).toEqual([])
      expect(h.reads()).toBe(0)
    }
  })

  it('refuses the Yes when a side was never asked anything, sending nothing', async () => {
    const h = await twoSessions(0.92)
    cleanups.push(configureStewardSwitches({ readSettings: () => ({}), environment: {} }))
    const consolidate = vi.fn()
    cleanups.push(
      registerStewardSuggestionAcceptor(
        'merge',
        stewardMergeAcceptor({ rows: h.deps.rows, goal: async () => null, consolidate })
      )
    )
    await runStewardOrganizePass(h.deps)
    const [suggestion] = await h.suggestions.open('merge')
    await expect(acceptStewardSuggestion(h.suggestions as never, suggestion!.id)).rejects.toThrow(
      'has not been asked anything yet'
    )
    expect(consolidate).not.toHaveBeenCalled()
  })

  it('refuses the open sg-05a469be shape: two “claude conversation” panes no person prompted', async () => {
    const h = await twoSessions(0.81, { title: 'claude conversation' })
    cleanups.push(configureStewardSwitches({ readSettings: () => ({}), environment: {} }))
    const consolidate = vi.fn()
    // One pane was never prompted; the other's only prompt is the steward's own question.
    const goals: Record<string, string | null> = {
      'view-1': null,
      'view-2':
        '[Question q-d26a02e4 from Session steward — answer only, change nothing] Write a handoff for another agent'
    }
    cleanups.push(
      registerStewardSuggestionAcceptor(
        'merge',
        stewardMergeAcceptor({
          rows: h.deps.rows,
          goal: async (observed) => goals[observed.row.viewKey] ?? null,
          consolidate
        })
      )
    )
    // Proposed before this rule existed, exactly as it sits in the store now.
    const open = await h.suggestions.propose({
      kind: 'merge',
      targets: [{ sessionKey: 'view-1' }, { sessionKey: 'view-2' }],
      proposal: { from: { sessionKey: 'view-1' }, into: { sessionKey: 'view-2' } },
      title: 'Merge “claude conversation” into “claude conversation”?',
      evidence: 'Same deliverable (0.81 both ways)'
    })
    await expect(acceptStewardSuggestion(h.suggestions as never, open!.id)).rejects.toThrow(
      '“claude conversation” has not been asked anything yet, so there is nothing to merge. Nothing changed.'
    )
    expect(consolidate).not.toHaveBeenCalled()
    expect((await h.suggestions.open('merge')).map((entry) => entry.id)).toEqual([open!.id])
  })

  it('merges only on Yes, as the accepting person, and stays open when the merge fails', async () => {
    const h = await twoSessions(0.92)
    cleanups.push(configureStewardSwitches({ readSettings: () => ({}), environment: {} }))
    const calls: Parameters<StewardConsolidate>[0][] = []
    let completed = false
    cleanups.push(
      registerStewardSuggestionAcceptor(
        'merge',
        stewardMergeAcceptor({
          rows: h.deps.rows,
          goal: h.deps.goal,
          consolidate: async (input) => {
            calls.push(input)
            return {
              completed,
              summary: completed
                ? 'Consolidated into “Export invoices”; archived 1 source after acknowledgement.'
                : 'Nothing archived: “Export invoices” did not acknowledge.'
            }
          }
        })
      )
    )
    await runStewardOrganizePass(h.deps)
    const [suggestion] = await h.suggestions.open('merge')
    await expect(acceptStewardSuggestion(h.suggestions as never, suggestion!.id)).rejects.toThrow(
      'did not acknowledge'
    )
    expect((await h.suggestions.open('merge')).map((entry) => entry.id)).toEqual([suggestion!.id])

    completed = true
    const result = await acceptStewardSuggestion(h.suggestions as never, suggestion!.id)
    expect(result.summary).toContain('archived 1 source after acknowledgement')
    expect(calls.at(-1)).toMatchObject({
      actor: { kind: 'steward', feature: 'suggestion', suggestionId: suggestion!.id },
      request: 'accepted in Work',
      source: { row: { viewKey: 'view-1' } },
      target: { row: { viewKey: 'view-2' } }
    })
  })
})
