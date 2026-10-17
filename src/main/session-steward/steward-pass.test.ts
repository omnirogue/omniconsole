import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeSessionChain } from '../../shared/session-chain-types'
import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'
import { reviseSessionOutcomeSet } from '../../shared/session-outcome-state'
import { SessionActionsLog } from '../session-manage/session-actions-log'
import { OrganizationChangeLedger } from '../session-organization/organization-change-ledger'
import { OrganizationHistoryStore } from '../session-organization/organization-history-store'
import type { StewardDoneness } from './steward-jev'
import { runStewardPass } from './steward-pass'
import { STEWARD_NUDGE_TEXT } from './steward-rules'
import {
  createStewardHarness,
  fakeSession,
  HOUR,
  ownStep,
  type FakeSession,
  type StewardHarness
} from './steward-test-fixtures'

const MARKER = '[from Session steward] '

let dir: string
let h: StewardHarness

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steward-pass-'))
  h = createStewardHarness(dir)
})
afterEach(async () => {
  await h.dispose()
  rmSync(dir, { recursive: true, force: true })
})

function reading(session: FakeSession, resolved: number, remainingWork: number): void {
  const turnKey = session.turn.turnKey!
  const unsure = [resolved, remainingWork].some((value) => value > 0.2 && value < 0.8)
  h.doneness.set(turnKey, { turnKey, resolved, remainingWork, unsure } satisfies StewardDoneness)
}
const workLeft = (session: FakeSession) => reading(session, 0.1, 0.9)
const finished = (session: FakeSession) => reading(session, 0.95, 0.05)

function newTurn(session: FakeSession, n: number, text = 'Still working through the parser.') {
  session.turn = { ...session.turn, turnKey: `turn-${session.row.paneKey}-${n}`, text }
}

const pass = () => runStewardPass(h.deps, h.memory)
const sent = () => vi.mocked(h.delivery.enqueue).mock.calls
const archives = () =>
  h.window.mock.calls.filter(
    ([request]) => (request as SessionFolderRelayRequest).kind === 'applyOrganizationChange'
  )

describe('nudges', () => {
  it('sends exactly one marked nudge in 12 h, and none once the session is pinned', async () => {
    const session = h.add(fakeSession('p1', { lastActivityAt: h.clock.now - HOUR }))
    workLeft(session)
    await pass()
    expect(sent()).toHaveLength(1)
    const [, queued] = sent()[0]!
    expect(queued.text.startsWith(MARKER)).toBe(true)
    expect(queued.text).toContain(STEWARD_NUDGE_TEXT)
    expect(queued.requestedBy).toEqual({ action: 'continue', actor: 'steward' })
    for (let n = 2; n <= 12; n += 1) {
      h.clock.now += HOUR
      newTurn(session, n)
      workLeft(session)
      await pass()
    }
    expect(sent()).toHaveLength(1)
    session.row = { ...session.row, pinned: true }
    h.clock.now += 2 * HOUR
    await pass()
    expect(sent()).toHaveLength(1)
    expect(h.state.read().daily.prompts).toBe(1)
  })

  it('nudges again after 12 h, then after two nudges with work left lists it as Stalled', async () => {
    const session = h.add(fakeSession('p1', { lastActivityAt: h.clock.now - HOUR }))
    workLeft(session)
    await pass()
    h.clock.now += 13 * HOUR
    newTurn(session, 2)
    workLeft(session)
    await pass()
    expect(sent()).toHaveLength(2)
    h.clock.now += 13 * HOUR
    newTurn(session, 3)
    workLeft(session)
    await pass()
    expect(sent()).toHaveLength(2)
    expect(h.state.session('p1')?.stalled?.reason).toBe(
      'nudged 2 times and it still has work left.'
    )
  })

  it('lists a refused nudge as Stalled with the refusal, and sends nothing', async () => {
    const session = h.add(fakeSession('p1', { lastActivityAt: h.clock.now - HOUR }))
    newTurn(session, 1, 'I drafted the change. Should I also update the docs?')
    workLeft(session)
    await pass()
    expect(sent()).toHaveLength(0)
    expect(h.state.session('p1')?.stalled?.reason).toMatch(/ends on a question/)
    expect(h.state.read().daily.prompts).toBe(0)
    const activity = h.state.read().activity.map((entry) => entry.kind)
    expect(activity).toContain('stalled')
    // Its next turn clears Stalled.
    h.clock.now += HOUR
    newTurn(session, 2, 'Docs are updated too.')
    finished(session)
    await pass()
    expect(h.state.session('p1')?.stalled).toBeUndefined()
  })

  it('never prompts a session under Keep going, and leaves its Keep going on', async () => {
    const session = h.add(
      fakeSession('p1', { lastActivityAt: h.clock.now - HOUR, keepGoing: true })
    )
    workLeft(session)
    await pass()
    const asking = h.add(
      fakeSession('p2', { keepGoing: true, pendingSteps: ['Add the migration'] })
    )
    asking.own = ownStep(asking, { title: 'Add the migration' })
    await pass()
    expect(sent()).toHaveLength(0)
    expect(h.delivery.decideRelayed).not.toHaveBeenCalled()
    expect(h.delivery.stopKeepGoing).not.toHaveBeenCalled()
    // Control: with Keep going off, the same session is nudged.
    session.keepGoing = false
    session.row = { ...session.row, title: 'Keep going turned off' }
    await pass()
    expect(sent()).toHaveLength(1)
  })
})

describe('safe Yes', () => {
  it('says yes to a single safe step inside the request, marked, once per turn', async () => {
    const session = h.add(fakeSession('p1', { pendingSteps: ['Add the migration'] }))
    session.own = ownStep(session, { title: 'Add the migration' })
    await pass()
    await pass()
    expect(h.delivery.decideRelayed).toHaveBeenCalledTimes(1)
    const [, , relayed] = vi.mocked(h.delivery.decideRelayed).mock.calls[0]!
    expect(relayed.prefix).toBe(MARKER)
    expect(relayed.requestedBy).toEqual({ action: 'continue', actor: 'steward' })
    expect(h.state.session('p1')?.yes).toMatchObject({ count: 1, lastTurnKey: 'turn-p1-1' })
  })

  it('refuses a hard-stop step, an ad budget raise included, and sends nothing', async () => {
    const session = h.add(fakeSession('p1', { pendingSteps: ['Raise the Spring promo budget'] }))
    session.own = ownStep(session, {
      title: 'Raise the Spring promo budget',
      prompt: 'Raise the Spring promo ad set daily budget to $300 in Meta Ads Manager.'
    })
    await pass()
    expect(h.delivery.decideRelayed).not.toHaveBeenCalled()
    expect(sent()).toHaveLength(0)
    const refused = h.state.read().activity.find((entry) => entry.kind === 'refused')
    expect(refused?.summary).toMatch(/hard stop: ad-spend/)
  })

  it('keeps the JEV gate while JEV is on: no reading yet means no Yes until one arrives', async () => {
    h.jevState.advances = null
    const session = h.add(fakeSession('p1', { pendingSteps: ['Add the migration'] }))
    session.own = ownStep(session, { title: 'Add the migration' })
    await pass()
    expect(h.delivery.decideRelayed).not.toHaveBeenCalled()
    h.jevState.advances = 3
    h.clock.now += 31 * 60_000
    await pass()
    expect(h.delivery.decideRelayed).toHaveBeenCalledTimes(1)
    expect(h.state.read().activity.at(-1)?.summary).toMatch(
      /\(JEV scored it 3\.0 of 4 against the request\)$/
    )
  })

  it('leaves a step JEV scores outside the request for the person', async () => {
    h.jevState.advances = 2
    const session = h.add(fakeSession('p1', { pendingSteps: ['Rewrite the README introduction'] }))
    session.own = ownStep(session, { title: 'Rewrite the README introduction' })
    await pass()
    expect(h.delivery.decideRelayed).not.toHaveBeenCalled()
    expect(h.state.read().activity.at(-1)?.summary).toMatch(/scored its step .* 2\.0 of 4/)
  })
})

describe('Tier 2 archive', () => {
  it('archives an idle local one-off JEV reads as finished after the continuous Done delay, with a result card', async () => {
    const session = h.add(fakeSession('p1', { lastActivityAt: h.clock.now - HOUR }))
    finished(session)
    await pass()
    expect(archives()).toHaveLength(0)
    h.clock.now += 2 * HOUR
    await pass()
    expect(archives()).toHaveLength(1)
    const change = (
      archives()[0]![0] as Extract<SessionFolderRelayRequest, { kind: 'applyOrganizationChange' }>
    ).change
    expect(change).toMatchObject({
      kind: 'archive',
      value: true,
      executor: { kind: 'app', feature: 'steward' },
      reason: 'finished, not verified',
      evidence: expect.stringContaining('JEV resolved 0.95 · quiet 3 h')
    })
    const card = h.cards.read('view-p1')
    expect(card).toMatchObject({
      title: 'Session p1',
      goal: 'Fix the parser',
      lastReply: 'I fixed the parser and the tests pass.',
      changedFiles: ['src/parser.ts'],
      branch: 'feat/parser',
      evidence: expect.stringContaining('JEV resolved 0.95 · quiet 3 h')
    })
    expect(card?.summary).toBeUndefined()

    // Undo still reverses it after a restart: a fresh ledger reads the same history.
    await h.ledger.flush()
    const store = new OrganizationHistoryStore({ directory: join(dir, 'session-organization') })
    store.load()
    const reopened = new OrganizationChangeLedger({ trail: new SessionActionsLog(dir), store })
    const plan = await reopened.undoPlan(change.opId)
    expect(plan.inverse).toMatchObject({ kind: 'unarchive', targets: [{ sessionKey: 'view-p1' }] })
    await reopened.flush()
  })

  it('never archives a session with an open recorded commitment, whatever JEV says', async () => {
    const session = h.add(fakeSession('p1', { lastActivityAt: h.clock.now - 20 * HOUR }))
    reading(session, 0.99, 0.01)
    const set = reviseSessionOutcomeSet(
      undefined,
      {
        expectedRevision: 0,
        source: 'user',
        outcomes: [
          {
            id: 'delivery',
            title: 'Merged',
            finish: 'complete',
            dependsOn: [],
            actions: [],
            conditions: [{ id: 'merge', kind: 'merge', target: 'https://example.test/pull/1' }]
          }
        ]
      },
      {
        owner: 'execution-host',
        hostId: 'local',
        epoch: 'epoch',
        state: 'owned',
        sourceVersion: 'turn1',
        sourceReady: true
      },
      1
    )
    h.chains.push(
      normalizeSessionChain({
        id: 'chain',
        workspacePath: '/w',
        worktreeId: session.row.worktreeId,
        sourcePaneKey: 'p1',
        sourceRowKey: session.row.rowKey,
        auto: true,
        steps: [],
        currentIndex: 0,
        state: 'waiting',
        createdAt: 1,
        updatedAt: 3,
        outcomeSet: set
      })!
    )
    await pass()
    expect(archives()).toHaveLength(0)
    expect(h.cards.read('view-p1')).toBeNull()
    expect(h.detector.run).toHaveBeenCalledWith([
      expect.objectContaining({
        paneKey: 'p1',
        kind: 'finished-held',
        reason: expect.stringMatching(/recorded outcomes are not finished/)
      })
    ])
  })
})

describe('what the steward never touches', () => {
  it('reports but never continues, asks or archives an SSH session, for a full day', async () => {
    const idle = h.add(
      fakeSession('ssh1', {
        row: { hostId: 'ssh:build-box' },
        lastActivityAt: h.clock.now - 10 * HOUR
      })
    )
    const exited = h.add(
      fakeSession('ssh2', {
        row: { hostId: 'ssh:build-box' },
        verdict: 'exited',
        lastActivityAt: h.clock.now - 10 * HOUR
      })
    )
    const waiting = h.add(
      fakeSession('ssh3', { row: { hostId: 'ssh:build-box' }, pendingSteps: ['Add the migration'] })
    )
    waiting.own = ownStep(waiting, { title: 'Add the migration' })
    for (let hour = 0; hour < 24; hour += 1) {
      workLeft(idle)
      finished(exited)
      await pass()
      h.clock.now += HOUR
      newTurn(idle, hour + 2)
      newTurn(exited, hour + 2)
    }
    expect(sent()).toHaveLength(0)
    expect(h.delivery.decideRelayed).not.toHaveBeenCalled()
    expect(archives()).toHaveLength(0)
    // Control: the same sessions on this computer are acted on at once.
    for (const session of [idle, exited, waiting]) {
      session.row = { ...session.row, hostId: 'local' }
    }
    workLeft(idle)
    finished(exited)
    await pass()
    expect(sent()).toHaveLength(1)
    expect(h.delivery.decideRelayed).toHaveBeenCalledTimes(1)
    expect(archives()).toHaveLength(1)
  })

  it('with JEV off, stops Tier 2 and nudges, while safe Yes (mechanical checks) and reports carry on', async () => {
    h.jevState.off = 'JEV is turned off on this computer'
    const done = h.add(fakeSession('p1', { lastActivityAt: h.clock.now - 10 * HOUR }))
    finished(done)
    const asking = h.add(fakeSession('p2', { pendingSteps: ['Add the migration'] }))
    asking.own = ownStep(asking, { title: 'Add the migration' })
    const stopping = h.add(fakeSession('p4', { pendingSteps: ['Deploy to production'] }))
    stopping.own = ownStep(stopping, {
      title: 'Deploy to production',
      prompt: 'Deploy the release to prod'
    })
    const left = h.add(fakeSession('p5', { lastActivityAt: h.clock.now - HOUR }))
    workLeft(left)
    const busy = h.add(fakeSession('p3', { activity: { kind: 'working' } }))
    h.deps.lastOutputAt = async () => h.clock.now - 15 * 60_000
    await pass()
    expect(archives()).toHaveLength(0)
    expect(sent()).toHaveLength(0)
    expect(h.deps.jev.advances).not.toHaveBeenCalled()
    // The single safe step is answered; the hard stop is still refused.
    expect(h.delivery.decideRelayed).toHaveBeenCalledTimes(1)
    expect(vi.mocked(h.delivery.decideRelayed).mock.calls[0]![0]).toBe('set-p2')
    const yes = h.state.read().activity.find((entry) => entry.kind === 'yes')
    expect(yes?.summary).toMatch(/\(mechanical checks only: JEV is turned off on this computer\)$/)
    expect(h.state.read().activity.find((entry) => entry.paneKey === 'p4')?.summary).toMatch(
      /hard stop: deploy/
    )
    expect(h.memory.silent.get('p3')).toMatchObject({ minutes: 15 })
    expect(busy.row.paneKey).toBe('p3')
  })

  it('with OMNI_STEWARD_DISABLED set, does nothing at all', async () => {
    h.env.OMNI_STEWARD_DISABLED = '1'
    const done = h.add(fakeSession('p1', { lastActivityAt: h.clock.now - 10 * HOUR }))
    finished(done)
    const asking = h.add(fakeSession('p2', { pendingSteps: ['Add the migration'] }))
    asking.own = ownStep(asking, { title: 'Add the migration' })
    await pass()
    expect(archives()).toHaveLength(0)
    expect(h.delivery.decideRelayed).not.toHaveBeenCalled()
    expect(sent()).toHaveLength(0)
    delete h.env.OMNI_STEWARD_DISABLED
    h.clock.now += 31 * 60_000
    await pass()
    expect(archives()).toHaveLength(1)
    expect(h.delivery.decideRelayed).toHaveBeenCalledTimes(1)
  })

  it('in shadow mode, records what it would do and does nothing', async () => {
    h.settings.safeYes = 'shadow'
    h.settings.tier2Archive = 'shadow'
    const done = h.add(fakeSession('p1', { lastActivityAt: h.clock.now - 10 * HOUR }))
    finished(done)
    const asking = h.add(fakeSession('p2', { pendingSteps: ['Add the migration'] }))
    asking.own = ownStep(asking, { title: 'Add the migration' })
    await pass()
    expect(archives()).toHaveLength(0)
    expect(h.delivery.decideRelayed).not.toHaveBeenCalled()
    expect(
      h.state
        .read()
        .activity.map((entry) => entry.kind)
        .toSorted()
    ).toEqual(['would-archive', 'would-yes'])
  })
})

describe('the pass', () => {
  it('reads the sidebar once for a burst of 100 changed sessions, then observes none unchanged', async () => {
    for (let n = 0; n < 100; n += 1) {
      h.add(fakeSession(`p${n}`, { activity: { kind: 'working' } }))
    }
    const first = await pass()
    expect(h.deps.readRows).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({ rows: 100, observed: 100 })
    const second = await pass()
    expect(h.deps.readRows).toHaveBeenCalledTimes(2)
    expect(second.observed).toBe(0)
  })

  it('asks an unclear, long-quiet session whether it is done, once per 24 h', async () => {
    const session = h.add(fakeSession('p1', { lastActivityAt: h.clock.now - 3 * HOUR }))
    reading(session, 0.5, 0.5)
    await pass()
    h.clock.now += 2 * HOUR
    newTurn(session, 2)
    reading(session, 0.5, 0.5)
    await pass()
    expect(sent()).toHaveLength(1)
    const [, queued] = sent()[0]!
    expect(queued.text).toMatch(
      /^\[Question q-\S+ from Session steward — answer only, change nothing\] /
    )
    expect(queued.text).toContain('In two lines: is your task complete, and what is left?')
    expect(queued.requestedBy).toEqual({ action: 'ask', actor: 'steward' })
  })
})
