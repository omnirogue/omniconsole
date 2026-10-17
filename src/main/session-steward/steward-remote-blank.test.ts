import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import {
  STEWARD_UNREACHABLE_BLANK_REASON,
  unreachableBlankEvidence,
  unreachableBlankRowMarker
} from '../../shared/session-steward-unreachable-blank'
import { configureSshReachabilityLog, noteSshTargetReached } from './ssh-reachability-log'
import { withUnreachableBlankRule } from './steward-remote-blank'
import { runStewardPass } from './steward-pass'
import {
  createStewardHarness,
  fakeSession,
  HOUR,
  type FakeSession,
  type StewardHarness
} from './steward-test-fixtures'

const MINUTE = 60_000
const EMPTY_TURN = {
  known: true,
  turnKey: null,
  text: null,
  complete: false,
  proposal: null,
  empty: true
}

let dir: string
let h: StewardHarness

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steward-remote-blank-'))
  h = createStewardHarness(dir)
})
afterEach(async () => {
  configureSshReachabilityLog(null)
  await h.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const pass = () => runStewardPass(h.deps, h.memory)
const requests = () => h.window.mock.calls.map(([request]) => request as SessionFolderRelayRequest)
const closes = () =>
  requests().filter((request) => request.kind === 'mutate' && request.op.kind === 'deleteSession')
const archives = () =>
  requests().flatMap((request) =>
    request.kind === 'applyOrganizationChange' ? [request.change] : []
  )

/** A blank pane on a connected SSH host that nobody touched since its agent started. */
function liveSsh(paneKey: string, ago: number, overrides: Parameters<typeof fakeSession>[1] = {}) {
  return h.add(
    fakeSession(paneKey, {
      lastActivityAt: h.clock.now - ago,
      prompted: 'untouched',
      turn: EMPTY_TURN,
      ...overrides,
      row: { hostId: 'ssh:devbox', ...overrides.row }
    })
  )
}

/** A blank row on an SSH host this computer has not reached for `ago` ms. */
function unreachable(
  paneKey: string,
  ago: number,
  overrides: Partial<Omit<FakeSession, 'row'>> & { row?: Partial<SessionManageSidebarRow> } = {}
): FakeSession {
  return h.add(
    fakeSession(paneKey, {
      verdict: 'unverifiable',
      activity: { kind: 'unknown', reason: 'Its host is not connected.' },
      lastActivityAt: h.clock.now - 2 * 24 * HOUR,
      turn: EMPTY_TURN,
      hook: { prompt: '', sessionBoundary: true },
      ...overrides,
      row: {
        hostId: 'ssh:devbox',
        hostUnavailable: true,
        title: 'claude conversation',
        providerSessionId: null,
        transcriptPath: null,
        emptyArchiveRevision: null,
        unreachableBlankRevision: `r-${paneKey}`,
        unreachableBlankPolicy: { revision: `r-${paneKey}`, since: h.clock.now - ago },
        ...overrides.row
      }
    })
  )
}

describe('blank panes on a connected SSH host', () => {
  it('closes one after 2 min through the same Delete, the relay ending it there', async () => {
    liveSsh('p1', MINUTE)
    await pass()
    expect(closes()).toHaveLength(0)
    h.clock.now += MINUTE
    await pass()
    expect(closes()).toHaveLength(1)
    expect(archives()).toHaveLength(0)
  })

  it('never claims its remote agent stopped when the host did not confirm the exit', async () => {
    // Why: a lost connection or a failed kill leaves the remote process running.
    h.window.stop.outcome = 'unconfirmed'
    liveSsh('p1', HOUR)
    await pass()
    expect(closes()).toHaveLength(1)
    const { summary } = h.state.read().activity.at(-1)!
    expect(summary).toMatch(/not confirmed stopped and may still be running/)
    expect(summary).not.toMatch(/its agent was stopped/)
  })

  it('never acts on one under the archive action, or one working, asking or read unknown', async () => {
    h.settings.emptySessionAction = 'archive'
    liveSsh('archive-action', HOUR)
    await pass()
    expect(requests()).toHaveLength(0)
    h.sessions.delete('archive-action')
    h.settings.emptySessionAction = 'close'
    liveSsh('working', HOUR, { activity: { kind: 'working' } })
    liveSsh('asking', HOUR, { activity: { kind: 'question' } })
    liveSsh('unknown', HOUR, { prompted: 'unknown' })
    h.memory.seen.clear()
    await pass()
    expect(requests()).toHaveLength(0)
  })

  it('never nudges or asks a prompted SSH session: only the blank rules reach it', async () => {
    liveSsh('prompted', 3 * HOUR, { prompted: 'person' })
    await pass()
    expect(requests()).toHaveLength(0)
    expect(h.delivery.enqueue).not.toHaveBeenCalled()
  })
})

describe('blank rows on an SSH host unreachable for a day', () => {
  it('archives one on this computer only, with its own reason and token', async () => {
    unreachable('p1', 25 * HOUR)
    await pass()
    expect(closes()).toHaveLength(0)
    expect(archives()).toHaveLength(1)
    const [change] = archives()
    expect(change).toMatchObject({
      kind: 'archive',
      executor: { kind: 'app', feature: 'steward' },
      reason: STEWARD_UNREACHABLE_BLANK_REASON
    })
    expect(change!.evidence).toContain(unreachableBlankEvidence('view-p1', 'r-p1'))
    expect(change!.evidence).toContain(unreachableBlankRowMarker('view-p1'))
    expect(change!.evidence!.length).toBeLessThan(200)
    // The settle recheck held: no put-back followed.
    expect(archives().filter((archive) => archive.kind === 'unarchive')).toHaveLength(0)
  })

  it('waits a full day, and never files one with a prompt, a title, a conversation or a pin', async () => {
    unreachable('young', 23 * HOUR)
    unreachable('prompted', 25 * HOUR, { hook: { prompt: 'fix it', sessionBoundary: true } })
    unreachable('replied', 25 * HOUR, { hook: { prompt: '', sessionBoundary: false } })
    unreachable('titled', 25 * HOUR, { row: { title: 'Fix the parser' } })
    unreachable('provider', 25 * HOUR, { row: { providerSessionId: 'abc' } })
    unreachable('pinned', 25 * HOUR, { row: { pinned: true } })
    unreachable('clockless', 25 * HOUR, { row: { unreachableBlankPolicy: null } })
    unreachable('no-report', 25 * HOUR, { hook: null })
    unreachable('queued', 25 * HOUR, { queueLength: 1 })
    await pass()
    expect(archives()).toHaveLength(0)
  })

  it('puts the row back when its host is reached while the archive settles', async () => {
    configureSshReachabilityLog(dir)
    const session = unreachable('p1', 25 * HOUR)
    const observe = h.deps.tier2.observe
    h.deps.tier2.observe = async (row) => {
      const read = await observe(row)
      // Why here: the settle recheck has captured the filed, still-unavailable row.
      if (session.row.archived) {
        noteSshTargetReached('devbox', h.clock.now)
      }
      return read
    }
    await pass()
    expect(archives().map((change) => change.kind)).toEqual(['archive', 'unarchive'])
    expect(archives()[1]!.reason).toMatch(/put back: .*its host was reached/)
  })

  it('puts the row back when its host was reached after the grant, before the recheck', async () => {
    configureSshReachabilityLog(dir)
    unreachable('p1', 25 * HOUR)
    const apply = h.window.getMockImplementation()!
    h.window.mockImplementationOnce(async (request) => {
      noteSshTargetReached('devbox', h.clock.now)
      return apply(request)
    })
    await pass()
    expect(archives().map((change) => change.kind)).toEqual(['archive', 'unarchive'])
  })

  it('starts the day over when this computer reached the host after the clock began', async () => {
    configureSshReachabilityLog(dir)
    noteSshTargetReached('devbox', h.clock.now - 2 * HOUR)
    unreachable('p1', 25 * HOUR)
    await pass()
    expect(archives()).toHaveLength(0)
  })

  it('re-reads only its own grant for the same row at the settle boundary', async () => {
    const row = unreachable('p1', 25 * HOUR).row
    const inner = async () => ({ ok: false as const, reason: 'inner rule' })
    const check = withUnreachableBlankRule(inner, h.deps.tier2)
    const target = { paneKey: row.paneKey!, tabId: row.tabId! }
    const context = { source: 'rules' as const }
    const granted = (evidence: string) => check({ target, context, recheck: { granted: evidence } })
    const ours = `blank on an unreachable host · ${unreachableBlankRowMarker('view-p1')} · reached never; #0`
    await expect(granted(ours)).resolves.toEqual({ ok: true, evidence: ours })
    noteSshTargetReached('devbox', h.clock.now)
    await expect(granted(ours)).resolves.toEqual({
      ok: false,
      reason: 'its host was reached after it was archived'
    })
    await expect(granted('nobody prompted it #0123456789abcdef')).resolves.toEqual({
      ok: false,
      reason: 'inner rule'
    })
    await expect(
      granted(`blank on an unreachable host · ${unreachableBlankRowMarker('view-other')}`)
    ).resolves.toMatchObject({ ok: false })
  })
})
