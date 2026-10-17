import {
  emptySessionEvidence,
  STEWARD_EMPTY_SESSION_CLOSE_REASON
} from '../../shared/session-steward-empty-session'
import { bumpConversationMutation } from '../runtime/conversation-mutation-generation'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'
import { SessionActionsLog } from '../session-manage/session-actions-log'
import { OrganizationChangeLedger } from '../session-organization/organization-change-ledger'
import { OrganizationHistoryStore } from '../session-organization/organization-history-store'
import { admitUnattendedOrganization } from '../session-manage/session-manage-unattended-admission'
import { stewardPromptedReading } from './steward-empty-session'
import { runStewardPass } from './steward-pass'
import { createStewardTier2Check } from './steward-tier2-check'
import {
  createStewardHarness,
  fakeSession,
  HOUR,
  type FakeSession,
  type StewardHarness
} from './steward-test-fixtures'

const MINUTE = 60_000

let dir: string
let h: StewardHarness

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steward-empty-'))
  h = createStewardHarness(dir)
})
afterEach(async () => {
  await h.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const pass = () => runStewardPass(h.deps, h.memory)
type ChangeRequest = Extract<SessionFolderRelayRequest, { kind: 'applyOrganizationChange' }>
type MutateRequest = Extract<SessionFolderRelayRequest, { kind: 'mutate' }>
const archives = () =>
  h.window.mock.calls
    .map(([request]) => request as SessionFolderRelayRequest)
    .filter((request): request is ChangeRequest => request.kind === 'applyOrganizationChange')
const closes = () =>
  h.window.mock.calls
    .map(([request]) => request as SessionFolderRelayRequest)
    .filter(
      (request): request is MutateRequest =>
        request.kind === 'mutate' && request.op.kind === 'deleteSession'
    )

/** An agent at its first prompt that nobody has asked anything, started `ago` ms ago. */
function emptySession(
  paneKey: string,
  ago: number,
  overrides: Parameters<typeof fakeSession>[1] = {}
): FakeSession {
  return h.add(
    fakeSession(paneKey, {
      lastActivityAt: h.clock.now - ago,
      prompted: 'none',
      turn: {
        known: true,
        turnKey: null,
        text: null,
        complete: false,
        proposal: null,
        empty: true
      },
      ...overrides
    })
  )
}

describe('stewardPromptedReading', () => {
  it('reads a person prompt from anything it saw, and none only from a whole reading', () => {
    const marked = '[from Session steward] Please continue.'
    expect(stewardPromptedReading({ prompts: ['', null], complete: true })).toBe('none')
    expect(stewardPromptedReading({ prompts: [marked], complete: true })).toBe('marked')
    expect(stewardPromptedReading({ prompts: [marked, 'fix the parser'], complete: true })).toBe(
      'person'
    )
    expect(stewardPromptedReading({ prompts: ['fix the parser'], complete: false })).toBe('person')
    expect(stewardPromptedReading({ prompts: [marked], complete: false })).toBe('unknown')
  })
})

describe('empty sessions, with the archive action', () => {
  beforeEach(() => {
    h.settings.emptySessionAction = 'archive'
    h.settings.emptySessionCloseMinutes = 30
  })

  it('archives an empty idle pane after 30 min and not before, and Undo restores it', async () => {
    emptySession('p1', 29 * MINUTE)
    await pass()
    expect(archives()).toHaveLength(0)
    h.clock.now += 2 * MINUTE
    await pass()
    expect(archives()).toHaveLength(1)
    const { change } = archives()[0]!
    expect(change).toMatchObject({
      kind: 'archive',
      value: true,
      executor: { kind: 'app', feature: 'steward' },
      reason: 'empty session: started with no prompt',
      evidence: `nobody prompted it · idle 31 min · queue empty · nothing held; ${emptySessionEvidence('view-p1', 'empty')}`
    })
    // Nothing to keep, so no result card.
    expect(h.cards.read('view-p1')).toBeNull()
    expect(h.state.read().activity.at(-1)).toMatchObject({ kind: 'archive' })

    await h.ledger.flush()
    const store = new OrganizationHistoryStore({ directory: join(dir, 'session-organization') })
    store.load()
    const reopened = new OrganizationChangeLedger({ trail: new SessionActionsLog(dir), store })
    const plan = await reopened.undoPlan(change.opId)
    expect(plan.inverse).toMatchObject({ kind: 'unarchive', targets: [{ sessionKey: 'view-p1' }] })
    await reopened.flush()
  })

  it('refuses when a prompt or keystroke reaches it while its facts are being read', async () => {
    const session = emptySession('p1', 31 * MINUTE)
    const prompted = h.deps.tier2.personPrompted!
    // Why here: this is the last await of the judgment; the queue write lands inside it.
    h.deps.tier2.personPrompted = async (row, observed) => {
      bumpConversationMutation(session.row.rowKey)
      return prompted(row, observed)
    }
    await pass()
    expect(archives()).toHaveLength(0)
    expect(h.state.read().activity.at(-1)).toMatchObject({ kind: 'refused' })
    expect(h.state.read().activity.at(-1)!.summary).toMatch(/while it was being checked/)
  })

  it('puts the row back when a prompt reaches it while the window is applying the archive', async () => {
    const session = emptySession('p1', 31 * MINUTE)
    const apply = h.window.getMockImplementation()!
    // Why once: the prompt lands after main's judgment and before the window's answer.
    h.window.mockImplementationOnce(async (request) => {
      session.prompted = 'person'
      return apply(request)
    })
    await pass()
    const changes = archives().map(({ change }) => change)
    expect(changes.map((change) => change.kind)).toEqual(['archive', 'unarchive'])
    expect(changes[1]).toMatchObject({
      executor: { kind: 'app', feature: 'steward' },
      undoOf: changes[0]!.opId,
      targets: [{ sessionKey: 'view-p1' }]
    })
    expect(changes[1]!.reason).toMatch(/put back: .*a person has asked it something/)
    // Why: a person's filing after the archive must refuse the inverse, so it names the revision.
    expect(changes[1]!.expectedRevision).toEqual(expect.any(String))
    expect(h.state.read().activity.at(-1)).toMatchObject({ kind: 'refused' })
    expect(h.state.read().activity.at(-1)!.summary).toMatch(/put back/)
  })

  it('never archives a session a person prompted, or one this computer cannot read', async () => {
    emptySession('p1', 3 * HOUR, { prompted: 'person' })
    emptySession('p2', 3 * HOUR, { prompted: 'unknown' })
    await pass()
    h.clock.now += 3 * HOUR
    await pass()
    expect(archives()).toHaveLength(0)
  })

  it('never archives a pinned, saved, working, queued, asking or remote pane', async () => {
    emptySession('pinned', 2 * HOUR, { row: { pinned: true } })
    emptySession('saved', 2 * HOUR, { row: { saved: true } })
    emptySession('working', 2 * HOUR, { activity: { kind: 'working' } })
    emptySession('queued', 2 * HOUR, { queueLength: 1 })
    emptySession('asking', 2 * HOUR, { pendingSteps: ['Pick a database'] })
    emptySession('remote', 2 * HOUR, { row: { hostId: 'ssh:devbox' } })
    await pass()
    h.clock.now += 2 * HOUR
    await pass()
    expect(archives()).toHaveLength(0)
  })

  it('uses the configured timeout, and does nothing while switched off or stopped', async () => {
    h.settings.emptySessionCloseMinutes = 60
    emptySession('p1', 45 * MINUTE)
    await pass()
    expect(archives()).toHaveLength(0)

    h.settings.emptySessionArchive = false
    h.clock.now += 30 * MINUTE
    await pass()
    expect(archives()).toHaveLength(0)

    h.settings.emptySessionArchive = true
    h.env.OMNI_STEWARD_DISABLED = '1'
    h.clock.now += MINUTE
    await pass()
    expect(archives()).toHaveLength(0)

    // An unchanged row is read again at its next check, at most 30 min later.
    delete h.env.OMNI_STEWARD_DISABLED
    h.clock.now += 31 * MINUTE
    await pass()
    expect(archives()).toHaveLength(1)
  })

  it('archives an empty session with the finished-session switch off, and only that', async () => {
    h.settings.tier2Archive = 'off'
    emptySession('p1', 40 * MINUTE)
    await pass()
    expect(archives()).toHaveLength(1)
    // A cleanup run asking for a finished session a person prompted is refused by the hook.
    const done = h.add(fakeSession('p2', { lastActivityAt: h.clock.now - 10 * HOUR }))
    h.doneness.set(done.turn.turnKey!, {
      turnKey: done.turn.turnKey!,
      resolved: 0.95,
      remainingWork: 0.05,
      unsure: false
    })
    const check = createStewardTier2Check(h.deps.tier2)
    await expect(
      check({ target: { paneKey: 'p2', tabId: 'tab-p2' }, context: { source: 'rules' } } as never)
    ).resolves.toEqual({ ok: false, reason: 'a person has asked it something' })
    h.settings.tier2Archive = 'on'
    await expect(
      check({ target: { paneKey: 'p2', tabId: 'tab-p2' }, context: { source: 'rules' } } as never)
    ).resolves.toMatchObject({ ok: true })
  })
})

/** A blank pane: nobody typed or sent anything since its agent started (the keystroke proof). */
function blankSession(
  paneKey: string,
  ago: number,
  overrides: Parameters<typeof fakeSession>[1] = {}
): FakeSession {
  return emptySession(paneKey, ago, { prompted: 'untouched', ...overrides })
}

const closedPanes = () =>
  closes().map(({ op }) => (op.kind === 'deleteSession' ? op.paneKey : null))

describe('blank sessions, closed through the sidebar’s Delete (the default)', () => {
  it('closes one after 2 min and not at 1:59, saying its agent stopped once confirmed', async () => {
    blankSession('p1', 2 * MINUTE - 1_000)
    await pass()
    expect(closes()).toHaveLength(0)
    h.clock.now += 1_000
    await pass()
    expect(closes()).toHaveLength(1)
    const { op, change } = closes()[0]!
    expect(op).toEqual({ kind: 'deleteSession', paneKey: 'p1', tabId: 'tab-p1' })
    expect(change).toMatchObject({
      executor: { kind: 'app', feature: 'steward' },
      reason: STEWARD_EMPTY_SESSION_CLOSE_REASON,
      evidence: `nobody prompted it · idle 2 min · queue empty · nothing held; ${emptySessionEvidence('view-p1', 'empty')}`
    })
    // Why a digest: S1 cuts evidence at 1000 characters, and the window compares this token.
    expect(change!.evidence!.length).toBeLessThan(200)
    expect(change!.evidence).toMatch(/#[0-9a-f]{16}$/)
    expect(archives()).toHaveLength(0)
    const last = h.state.read().activity.at(-1)!
    expect(last.kind).toBe('close')
    expect(last.summary).toMatch(
      /its tab closed and its agent was stopped\. Reopen it from Recently closed/
    )
    const history = await h.ledger.history('view-p1')
    expect(history.entries.find((entry) => entry.kind === 'delete')).toMatchObject({
      kind: 'delete',
      phase: 'applied',
      executor: { kind: 'app', feature: 'steward' },
      reason: STEWARD_EMPTY_SESSION_CLOSE_REASON
    })
  })

  it('never closes on a transcript-only reading, a marked prompt, a person or unknown', async () => {
    blankSession('none', 2 * HOUR, { prompted: 'none' })
    blankSession('marked', 2 * HOUR, { prompted: 'marked' })
    blankSession('person', 2 * HOUR, { prompted: 'person' })
    blankSession('unknown', 2 * HOUR, { prompted: 'unknown' })
    await pass()
    h.clock.now += HOUR
    await pass()
    expect(closes()).toHaveLength(0)
    expect(archives()).toHaveLength(0)
  })

  it('never closes one on screen, and restarts the clock when its tab was looked at', async () => {
    // Why null: the window's revision turns null while its tab is in front.
    blankSession('shown', 2 * HOUR, { row: { emptyArchiveRevision: null } })
    blankSession('glanced', 2 * HOUR, { row: { lastSeenAt: h.clock.now - MINUTE } })
    await pass()
    expect(closes()).toHaveLength(0)
    h.clock.now += MINUTE
    await pass()
    expect(closedPanes()).toEqual(['glanced'])
  })

  it('never closes a pinned, saved, working, queued, launching or Keep going pane', async () => {
    blankSession('pinned', 2 * HOUR, { row: { pinned: true } })
    blankSession('saved', 2 * HOUR, { row: { saved: true } })
    blankSession('working', 2 * HOUR, { activity: { kind: 'working' } })
    blankSession('queued', 2 * HOUR, { queueLength: 1 })
    blankSession('launching', 2 * HOUR, { row: { launchPending: true } })
    blankSession('driven', 2 * HOUR, { keepGoing: true })
    await pass()
    h.clock.now += HOUR
    await pass()
    expect(closes()).toHaveLength(0)
  })

  it('removes a blank pane whose agent already exited at once', async () => {
    blankSession('gone', 5_000, { verdict: 'exited' })
    await pass()
    expect(closedPanes()).toEqual(['gone'])
    expect(h.state.read().activity.at(-1)!.summary).toMatch(/its agent had already exited/)
  })

  it('reads an agent with no idle marker yet as at its prompt only on the proof', async () => {
    const unknown = { kind: 'unknown' as const, reason: 'no idle marker on its screen' }
    blankSession('starting', 2 * HOUR, { activity: unknown })
    blankSession('elsewhere', 2 * HOUR, { activity: unknown, agentForeground: false })
    blankSession('transcript', 2 * HOUR, { activity: unknown, prompted: 'none' })
    await pass()
    expect(closedPanes()).toEqual(['starting'])
  })

  it('refuses when a keystroke reaches it while its facts are being read', async () => {
    const session = blankSession('p1', HOUR)
    const prompted = h.deps.tier2.personPrompted!
    h.deps.tier2.personPrompted = async (row, observed) => {
      bumpConversationMutation(session.row.rowKey)
      return prompted(row, observed)
    }
    await pass()
    expect(closes()).toHaveLength(0)
    expect(h.state.read().activity.at(-1)!.summary).toMatch(/while it was being checked/)
  })

  it('stops a close when a keystroke lands after it was admitted, before it is sent', async () => {
    const session = blankSession('p1', HOUR)
    const prepare = h.ledger.prepare.bind(h.ledger)
    h.ledger.prepare = async (...args) => {
      bumpConversationMutation(session.row.rowKey)
      return prepare(...args)
    }
    await pass()
    expect(closes()).toHaveLength(0)
    expect(h.state.read().activity.at(-1)!.summary).toMatch(/just before it was closed/)
  })

  it('never claims the agent stopped when its exit was not confirmed', async () => {
    // Why: the kill is sent without waiting; a failed kill leaves the process running.
    h.window.stop.outcome = 'unconfirmed'
    blankSession('p1', HOUR)
    await pass()
    expect(closes()).toHaveLength(1)
    const { summary } = h.state.read().activity.at(-1)!
    expect(summary).toMatch(/its agent was not confirmed stopped and may still be running/)
    expect(summary).not.toMatch(/its agent was stopped/)
  })

  it('records the window’s last-moment refusal and closes nothing', async () => {
    blankSession('p1', HOUR)
    h.window.mockImplementationOnce(async () => {
      throw new Error('The session is on screen; it stays open.')
    })
    await pass()
    expect(h.state.read().activity.at(-1)).toMatchObject({ kind: 'refused' })
    expect(h.state.read().activity.at(-1)!.summary).toMatch(/Did not close .*on screen/)
    expect(h.sessions.has('p1')).toBe(true)
  })

  it('archives instead under the archive action, and never lets a cleanup run close', async () => {
    h.settings.emptySessionAction = 'archive'
    blankSession('p1', HOUR)
    await pass()
    expect(closes()).toHaveLength(0)
    expect(archives()).toHaveLength(1)
    const cleanup = {
      kind: 'pane' as const,
      paneKey: 'cleanup',
      title: 'Cleanup',
      unattended: { source: 'cleanup-run' as const, runId: 'run-1' }
    }
    h.settings.emptySessionAction = 'close'
    await expect(
      admitUnattendedOrganization(cleanup, {
        kind: 'delete',
        value: true,
        targets: [{ paneKey: 'p1' }]
      })
    ).rejects.toThrow(/that needs the person/)
  })
})
