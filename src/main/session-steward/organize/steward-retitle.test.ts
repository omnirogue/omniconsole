import { afterEach, describe, expect, it } from 'vitest'
import type { OrganizationExecutor } from '../../../shared/session-organization-change'
import { runStewardOrganizePass } from './steward-organize-pass'
import {
  folder,
  HOUR,
  organizeHarness,
  organizeRow,
  type ScriptedJev
} from './steward-organize-test-fixtures'
import type { StewardTitleReading } from './steward-retitle'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()!()
  }
})

const LAUNCH: OrganizationExecutor = { kind: 'launch', source: 'session-launch' }
const FIRST = { key: 'g1', index: 0, title: 'Ship the toggle', cause: 'PR #11 opened' }
const SECOND = { key: 'g2', index: 1, title: 'New prototype', cause: 'PR #12 opened' }
const PICK_FIRST_CANDIDATE: ScriptedJev['title'] = (candidates) => ({
  pick: candidates[0]!,
  p: 0.8
})

function reading(patch: Partial<StewardTitleReading> = {}): StewardTitleReading {
  return { goal: null, turn: null, instruction: null, card: null, ...patch }
}

async function titled(
  executor: OrganizationExecutor,
  origin: 'generated' | 'yours' | 'unknown',
  jev: Partial<ScriptedJev> = {}
) {
  const row = organizeRow(1, { title: 'Ship the toggle' }, { lastActivityAt: 1 })
  const h = await organizeHarness([row], [folder('f', 'Ads')], {
    folder: () => ({ failed: 'not asked here' }),
    onGoal: () => 0.9,
    title: PICK_FIRST_CANDIDATE,
    ...jev
  })
  cleanups.push(h.cleanup)
  h.other.mergeSuggestions = 'off'
  h.other.projectSuggestions = 'off'
  h.modes.refile = 'off'
  h.record({
    kind: 'title',
    targets: [{ sessionKey: 'view-1' }],
    value: 'Ship the toggle',
    executor,
    origin
  })
  h.advance(2 * HOUR)
  let activity = 1
  /** A new reading of the session after a turn; `state` defaults to idle. */
  const turn = (next: StewardTitleReading, state: 'idle' | 'working' = 'idle') => {
    activity += 1
    h.readings.set('view-1', next)
    h.rows[0]!.entry = { ...h.rows[0]!.entry, state, lastActivityAt: activity }
  }
  h.readings.set('view-1', reading())
  return { h, turn }
}

describe('titles follow the goal', () => {
  it('uses a summary title that arrives after the same idle turn was already read', async () => {
    const { h } = await titled(LAUNCH, 'generated')
    const titles = new Map<string, string>()
    h.deps.summaryTitles = async () => titles
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toEqual([])

    titles.set('view-1', 'Recover checkout retries')
    const outcome = await runStewardOrganizePass(h.deps)
    expect(outcome.retitled).toEqual(['view-1'])
    expect(h.retitles).toEqual([
      {
        key: 'view-1',
        title: 'Recover checkout retries',
        reason: 'compact summary describes the current work',
        expectedRevision: 'r-1'
      }
    ])

    h.advance(2 * HOUR)
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toHaveLength(1)
  })

  it('keeps person-owned and unknown titles when a summary offers a new name', async () => {
    const cases: [OrganizationExecutor, 'generated' | 'yours' | 'unknown'][] = [
      [{ kind: 'person', via: 'sidebar' }, 'yours'],
      [{ kind: 'pane', paneKey: 'tab-9:leaf-1', title: 'Agent' }, 'yours'],
      [LAUNCH, 'unknown']
    ]
    for (const [executor, origin] of cases) {
      const { h } = await titled(executor, origin)
      h.deps.summaryTitles = async () => new Map([['view-1', 'Recover checkout retries']])
      await runStewardOrganizePass(h.deps)
      expect(h.retitles).toEqual([])
      expect(h.rows[0]!.row.title).toBe('Ship the toggle')
      expect(h.calls.some((call) => call.questions.title)).toBe(false)
    }
  })

  it('waits for an active session to become idle before applying a summary title', async () => {
    const { h, turn } = await titled(LAUNCH, 'generated')
    h.deps.summaryTitles = async () => new Map([['view-1', 'Recover checkout retries']])
    turn(reading(), 'working')
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toEqual([])

    turn(reading())
    await runStewardOrganizePass(h.deps)
    expect(h.retitles.map((entry) => entry.title)).toEqual(['Recover checkout retries'])
  })

  it('retries a summary first seen during the title cooldown without needing a new turn', async () => {
    const { h } = await titled(LAUNCH, 'generated')
    h.record({
      kind: 'title',
      targets: [{ sessionKey: 'view-1' }],
      value: 'Ship the toggle',
      executor: LAUNCH,
      origin: 'generated'
    })
    h.deps.summaryTitles = async () => new Map([['view-1', 'Recover checkout retries']])
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toEqual([])

    h.advance(HOUR)
    await runStewardOrganizePass(h.deps)
    expect(h.retitles.map((entry) => entry.title)).toEqual(['Recover checkout retries'])
  })

  it('re-titles once when a second PR follows the first, and never while working', async () => {
    const { h, turn } = await titled(LAUNCH, 'generated')
    h.readings.set('view-1', reading({ goal: FIRST }))
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toEqual([])

    turn(reading({ goal: SECOND }), 'working')
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toEqual([])

    turn(reading({ goal: SECOND }))
    const outcome = await runStewardOrganizePass(h.deps)
    expect(outcome.retitled).toEqual(['view-1'])
    expect(h.retitles).toEqual([
      {
        key: 'view-1',
        title: 'New prototype',
        reason: 'goal changed: PR #12 opened',
        expectedRevision: 'r-1'
      }
    ])
    expect(h.rows[0]!.row.title).toBe('New prototype')
    expect(h.guard.state('retitle').samples).toBe(1)

    for (let pass = 0; pass < 2; pass += 1) {
      h.advance(2 * HOUR)
      turn(reading({ goal: SECOND }))
      await runStewardOrganizePass(h.deps)
    }
    expect(h.retitles).toHaveLength(1)
  })

  it('never changes a title a person typed, dictated through an agent, or of unknown origin', async () => {
    const cases: [OrganizationExecutor, 'generated' | 'yours' | 'unknown'][] = [
      [{ kind: 'person', via: 'sidebar' }, 'yours'],
      [{ kind: 'pane', paneKey: 'tab-9:leaf-1', title: 'Agent' }, 'yours'],
      [LAUNCH, 'unknown']
    ]
    for (const [executor, origin] of cases) {
      const { h, turn } = await titled(executor, origin)
      h.readings.set('view-1', reading({ goal: FIRST }))
      await runStewardOrganizePass(h.deps)
      turn(reading({ goal: SECOND }))
      await runStewardOrganizePass(h.deps)
      expect(h.retitles).toEqual([])
    }
  })

  it('waits out the hour after any title change, then re-titles', async () => {
    const { h, turn } = await titled(LAUNCH, 'generated')
    h.readings.set('view-1', reading({ goal: FIRST }))
    await runStewardOrganizePass(h.deps)
    h.record({
      kind: 'title',
      targets: [{ sessionKey: 'view-1' }],
      value: 'Ship the toggle',
      executor: LAUNCH,
      origin: 'generated'
    })
    turn(reading({ goal: SECOND }))
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toEqual([])
    h.advance(HOUR)
    await runStewardOrganizePass(h.deps)
    expect(h.retitles.map((entry) => entry.title)).toEqual(['New prototype'])
  })

  it('does not go back to an older goal when GitHub cannot answer for the newest PR', async () => {
    const { h, turn } = await titled(LAUNCH, 'generated')
    h.readings.set('view-1', reading({ goal: SECOND }))
    await runStewardOrganizePass(h.deps)
    turn(reading({ goal: FIRST }))
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toEqual([])
  })

  it('changes nothing when JEV keeps the title, is unsure, or is off', async () => {
    for (const title of [
      () => ({ pick: 'keep', p: 0.9 }),
      (candidates: string[]) => ({ pick: candidates[0]!, p: 0.55 }),
      () => null
    ]) {
      const { h, turn } = await titled(LAUNCH, 'generated', { title })
      h.readings.set('view-1', reading({ goal: FIRST }))
      await runStewardOrganizePass(h.deps)
      turn(reading({ goal: SECOND }))
      await runStewardOrganizePass(h.deps)
      expect(h.retitles).toEqual([])
    }
  })

  it('re-titles after two finished turns in a row read off the goal, never after one', async () => {
    const scores = new Map([
      ['Drafted the partner email.', 0.1],
      ['Sent the partner email.', 0.15],
      ['Back on the toggle.', 0.8]
    ])
    const { h, turn } = await titled(LAUNCH, 'generated', {
      onGoal: (text) => scores.get(text) ?? 0.9
    })
    const instruction = 'Draft the partner email. Then send it.'
    turn(reading({ turn: { key: 't1', text: 'Drafted the partner email.' }, instruction }))
    await runStewardOrganizePass(h.deps)
    turn(reading({ turn: { key: 't2', text: 'Back on the toggle.' }, instruction }))
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toEqual([])

    turn(reading({ turn: { key: 't3', text: 'Drafted the partner email.' }, instruction }))
    await runStewardOrganizePass(h.deps)
    // The same finished turn read again is not a second reading.
    turn(reading({ turn: { key: 't3', text: 'Drafted the partner email.' }, instruction }))
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toEqual([])

    turn(reading({ turn: { key: 't4', text: 'Sent the partner email.' }, instruction }))
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toEqual([
      expect.objectContaining({
        title: 'Draft the partner email',
        reason: 'two finished turns moved off the goal'
      })
    ])
  })

  it('re-titles when a task card is attached or changed, not when one is first seen', async () => {
    const { h, turn } = await titled(LAUNCH, 'generated')
    const card = { key: 'btk_1\nRefund flow', title: 'Refund flow' }
    h.readings.set('view-1', reading({ card }))
    await runStewardOrganizePass(h.deps)
    turn(reading({ card }))
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toEqual([])

    const renamed = { key: 'btk_1\nRefunds for annual plans', title: 'Refunds for annual plans' }
    turn(reading({ card: renamed }))
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toEqual([
      expect.objectContaining({
        title: 'Refunds for annual plans',
        reason: 'task card: Refunds for annual plans'
      })
    ])
  })

  it("offers the agent's own title to JEV when the goal moves on", async () => {
    let offered: string[] = []
    const { h, turn } = await titled(LAUNCH, 'generated', {
      title: (candidates) => {
        offered = candidates
        return { pick: 'Memory allowance', p: 0.8 }
      }
    })
    h.readings.set('view-1', reading({ goal: FIRST }))
    await runStewardOrganizePass(h.deps)
    turn(reading({ goal: SECOND, aiTitle: 'Memory allowance' }))
    await runStewardOrganizePass(h.deps)
    expect(offered).toEqual(['New prototype', 'Memory allowance'])
    expect(h.retitles).toEqual([expect.objectContaining({ title: 'Memory allowance' })])
  })

  it('never re-titles a session whose only prompt came from the steward', async () => {
    const { h, turn } = await titled(LAUNCH, 'generated')
    h.deps.goal = async () =>
      '[Question q-d26a02e4 from Session steward — answer only, change nothing] Write a handoff'
    h.readings.set('view-1', reading({ goal: FIRST }))
    await runStewardOrganizePass(h.deps)
    turn(reading({ goal: SECOND }))
    await runStewardOrganizePass(h.deps)
    expect(h.retitles).toEqual([])
  })

  it('does nothing while re-titling is paused or off', async () => {
    const { h, turn } = await titled(LAUNCH, 'generated')
    h.readings.set('view-1', reading({ goal: FIRST }))
    await runStewardOrganizePass(h.deps)
    h.modes.retitle = 'paused'
    turn(reading({ goal: SECOND }))
    expect((await runStewardOrganizePass(h.deps)).stopped).toContain('re-titling is paused')
    expect(h.retitles).toEqual([])
  })
})
