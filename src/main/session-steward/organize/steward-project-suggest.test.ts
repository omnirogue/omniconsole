import { afterEach, describe, expect, it } from 'vitest'
import { mayEstablishOwnership } from '../../../shared/session-organization-change'
import { configureStewardSwitches } from '../steward-switches'
import { folder, HOUR, organizeHarness, organizeRow } from './steward-organize-test-fixtures'
import { runStewardOrganizePass } from './steward-organize-pass'
import { stewardProjectAcceptor } from './steward-project-suggest'
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

const BATCH = 'f-batch'

async function batchOfFour(createdHoursAgo: number, lastActivityHoursAgo: number) {
  const start = Date.parse('2026-09-26T08:00:00Z')
  const rows = [1, 2, 3, 4].map((index) =>
    organizeRow(
      index,
      { folderId: BATCH, folder: 'Checkout redesign' },
      { state: 'working', lastActivityAt: start - lastActivityHoursAgo * HOUR }
    )
  )
  const h = await organizeHarness(rows, [folder(BATCH, 'Checkout redesign')], {
    folder: () => ({ path: 'none', p: 0.9 })
  })
  cleanups.push(h.cleanup)
  h.setOrigins({
    folders: {
      [BATCH]: {
        folderId: BATCH,
        batchId: 'b1',
        requestExcerpt: 'Redesign the checkout page. Then ship it.',
        createdAt: start - createdHoursAgo * HOUR,
        source: 'session-prep'
      }
    },
    sessions: {}
  })
  return h
}

describe('make this a project', () => {
  it('suggests one project for a day-old batch of four still at work', async () => {
    const h = await batchOfFour(25, 1)
    const outcome = await runStewardOrganizePass(h.deps)
    expect(outcome.projects).toHaveLength(1)
    const [suggestion] = await h.suggestions.open('project')
    expect(suggestion).toMatchObject({
      title: 'Make “Checkout redesign” a project?',
      proposal: {
        folderId: BATCH,
        folderPath: 'Checkout redesign',
        name: 'Redesign the checkout page'
      },
      targets: [1, 2, 3, 4].map((index) => ({ sessionKey: `view-${index}` }))
    })
    await runStewardOrganizePass(h.deps)
    expect(await h.suggestions.open('project')).toHaveLength(1)
  })

  it('suggests nothing for a batch under a day old, quiet for a day, or switched off', async () => {
    expect((await runStewardOrganizePass((await batchOfFour(20, 1)).deps)).projects).toEqual([])
    const quiet = await batchOfFour(48, 30)
    for (const row of quiet.rows) {
      row.entry = { ...row.entry, state: 'idle' }
    }
    expect((await runStewardOrganizePass(quiet.deps)).projects).toEqual([])
    const off = await batchOfFour(25, 1)
    off.other.projectSuggestions = 'off'
    expect((await runStewardOrganizePass(off.deps)).projects).toEqual([])
  })

  it('on Yes moves the four into a Saved project folder, placement still the steward’s', async () => {
    const h = await batchOfFour(25, 1)
    cleanups.push(configureStewardSwitches({ readSettings: () => ({}), environment: {} }))
    cleanups.push(registerStewardSuggestionAcceptor('project', stewardProjectAcceptor(h.deps)))
    await runStewardOrganizePass(h.deps)
    const [suggestion] = await h.suggestions.open('project')

    const result = await acceptStewardSuggestion(h.suggestions as never, suggestion!.id)

    expect(result.summary).toBe(
      'Moved 4 sessions into Saved Sessions / Redesign the checkout page.'
    )
    const { plan, actor } = h.applied.at(-1)!
    expect(actor).toEqual({ kind: 'steward', feature: 'suggestion', suggestionId: suggestion!.id })
    expect(plan).toMatchObject({
      request: 'accepted in Work',
      folders: [{ create: 'Saved Sessions / Redesign the checkout page' }]
    })
    for (const index of [1, 2, 3, 4]) {
      const [move] = h.history.entriesFor(`view-${index}`)
      expect(move).toMatchObject({
        kind: 'move',
        executor: { kind: 'app', feature: 'steward' },
        request: 'accepted in Work'
      })
      // Not the person's placement, so Tier 2 may still archive it.
      expect(mayEstablishOwnership(move!)).toBe(true)
      expect(h.history.stateFor(`view-${index}`).ownership.placement?.by).toBe('app')
      expect(h.history.stateFor(`view-${index}`).revocations.placement).toBeUndefined()
    }
    // Accepted suggestions are not re-filing samples for the accuracy guard.
    expect(h.guard.state('refile').samples).toBe(0)
  })
})
