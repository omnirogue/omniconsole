import { afterEach, describe, expect, it } from 'vitest'
import {
  folder,
  HOUR,
  organizeHarness,
  organizeRow,
  PERSON,
  type ScriptedJev
} from './steward-organize-test-fixtures'
import { runStewardOrganizePass } from './steward-organize-pass'
import { STEWARD_ORGANIZE_ACTOR } from './steward-refile'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()!()
  }
})

const FOLDERS = () => [folder('f-acme', 'Clients / Acme'), folder('f-ads', 'Ads')]

async function harness(rows = [organizeRow(1)], script?: ScriptedJev) {
  const made = await organizeHarness(
    rows,
    FOLDERS(),
    script ?? { folder: () => ({ path: 'Clients / Acme', p: 0.91 }) }
  )
  cleanups.push(made.cleanup)
  return made
}

describe('steward re-filing', () => {
  it('moves a session JEV places at 0.91 twice a day apart, once, and not again that day', async () => {
    const h = await harness()
    expect((await runStewardOrganizePass(h.deps)).moved).toEqual([])
    expect(h.calls).toHaveLength(1)
    h.advance(10 * HOUR)
    // A reading only 10 h old is not re-read, and one reading never moves anything.
    expect((await runStewardOrganizePass(h.deps)).moved).toEqual([])
    expect(h.calls).toHaveLength(1)

    h.advance(11 * HOUR)
    expect((await runStewardOrganizePass(h.deps)).moved).toEqual(['view-1'])
    expect(h.applied).toEqual([
      {
        actor: STEWARD_ORGANIZE_ACTOR,
        plan: {
          reason: 'JEV folder fit 0.91, two readings',
          changes: [{ pane: 'tab-1:leaf-1', folder: 'Clients / Acme', expectedRevision: 'none' }]
        }
      }
    ])
    const [move] = h.history.entriesFor('view-1')
    expect(move).toMatchObject({ kind: 'move', executor: { kind: 'app', feature: 'steward' } })
    // The guard counts it, so a person's Undo counts against re-filing.
    expect(h.guard.state('refile').samples).toBe(1)

    // Now filed by the steward in Acme; JEV names Ads twice, but not within the day.
    h.deps.decide = async (request) => {
      const choice = Object.entries(
        (request.questions.folder as { criteria: Record<string, string> }).criteria
      ).find(([, path]) => path === 'Ads')![0]
      return {
        provider: 't',
        model: 't',
        usage: { inputTokens: 0, outputTokens: 0 },
        answers: {
          folder: { type: 'choice', choice, probabilities: { [choice]: 0.95 }, confidence: 0.95 }
        }
      }
    }
    h.advance(HOUR)
    await runStewardOrganizePass(h.deps)
    h.advance(21 * HOUR)
    expect((await runStewardOrganizePass(h.deps)).moved).toEqual([])
    expect(h.applied).toHaveLength(1)
  })

  it('never moves a session a person filed, or one a person touched in the last day', async () => {
    const filed = organizeRow(1, { folderId: 'f-ads', folder: 'Ads' })
    const touched = organizeRow(2)
    const h = await harness([filed, touched])
    h.record({
      kind: 'move',
      targets: [{ sessionKey: 'view-1' }],
      value: 'f-ads',
      executor: PERSON
    })
    h.record({ kind: 'tag', targets: [{ sessionKey: 'view-2' }], value: 'x', executor: PERSON })
    for (let pass = 0; pass < 4; pass += 1) {
      await runStewardOrganizePass(h.deps)
      h.advance(21 * HOUR)
    }
    // Session 1 never: its placement is the person's. Session 2 only once the day has passed.
    expect(h.applied.flatMap((entry) => entry.plan.changes.map((change) => change.pane))).toEqual([
      'tab-2:leaf-1'
    ])
    expect(
      h.calls
        .filter((request) => request.questions.folder)
        .every((request) => !JSON.stringify(request.state).includes('Session 1'))
    ).toBe(true)
  })

  it('reads nothing for a session nobody has asked anything yet', async () => {
    const h = await harness([organizeRow(1)])
    h.deps.goal = async () => null
    await runStewardOrganizePass(h.deps)
    expect(h.calls.filter((request) => request.questions.folder)).toEqual([])
    expect(await h.suggestions.open('unplaced')).toEqual([])
  })

  it('leaves busy, pinned, saved and remote sessions alone', async () => {
    const rows = [
      organizeRow(1, {}, { state: 'working' }),
      organizeRow(2, { pinned: true }),
      organizeRow(3, { saved: true, folderId: 's', folder: 'Saved Sessions / Q3' }),
      organizeRow(4, { hostId: 'ssh:box' }, { hostId: 'ssh:box' })
    ]
    const h = await harness(rows)
    await runStewardOrganizePass(h.deps)
    expect(h.calls).toEqual([])
  })

  it('lists a 0.7 reading as “couldn’t place” and moves nothing', async () => {
    const h = await harness([organizeRow(1)], {
      folder: () => ({ path: 'Clients / Acme', p: 0.7 })
    })
    const outcome = await runStewardOrganizePass(h.deps)
    expect(outcome.unplaced).toEqual(['view-1'])
    const [unplaced] = await h.suggestions.open('unplaced')
    expect(unplaced).toMatchObject({
      title: '1 session could not be placed in a folder',
      targets: [{ sessionKey: 'view-1', paneKey: 'tab-1:leaf-1', tabId: 'tab-1' }]
    })
    h.advance(21 * HOUR)
    await runStewardOrganizePass(h.deps)
    expect(h.applied).toEqual([])
  })

  it('moves nothing while the guard holds re-filing paused, or JEV fails', async () => {
    const h = await harness()
    h.modes.refile = 'paused'
    await runStewardOrganizePass(h.deps)
    h.advance(21 * HOUR)
    expect((await runStewardOrganizePass(h.deps)).stopped).toContain('re-filing is paused')
    expect(h.calls).toEqual([])

    h.modes.refile = 'on'
    h.deps.decide = async () => ({ failed: 'JEV decisions are disabled' })
    expect((await runStewardOrganizePass(h.deps)).stopped).toContain(
      'JEV: JEV decisions are disabled'
    )
    expect(h.applied).toEqual([])
    expect(await h.suggestions.open('unplaced')).toEqual([])
  })

  it('pauses itself after the person undoes too many moves', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => organizeRow(index + 1))
    const h = await harness(rows)
    await runStewardOrganizePass(h.deps)
    h.advance(21 * HOUR)
    await runStewardOrganizePass(h.deps)
    expect(h.applied).toHaveLength(8)
    for (const index of [1, 2, 3]) {
      const move = h.history.entriesFor(`view-${index}`)[0]!
      h.record({
        kind: 'move',
        targets: [{ sessionKey: `view-${index}` }],
        value: null,
        executor: { kind: 'person', via: 'work' },
        undoOf: move.opId
      })
    }
    expect(h.guard.state('refile')).toMatchObject({ mode: 'paused', corrected: 3, samples: 8 })
  })
})
