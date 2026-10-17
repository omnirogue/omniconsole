import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { CleanupAdmission } from '../../shared/session-cleanup-run'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { readAwaitedSessionResult } from './steward-awaited-session'
import { buildStewardResultCard, StewardResultCardStore } from './steward-result-card'
import { StewardPileupDetector } from './steward-pileup-detector'
import { registerStewardPackageSeams } from './steward-package-seams'
import { configureStewardSwitches } from './steward-switches'
import { sessionWaitersOf } from './steward-waiter-source'

const admissions = vi.hoisted(() => ({
  next: null as CleanupAdmission | null,
  calls: [] as { source: string; leftovers?: readonly string[] }[]
}))
vi.mock('./cleanup-runs-runtime', () => ({
  admitCleanupRun: (source: string, input?: { leftovers?: readonly string[] }) => {
    admissions.calls.push({ source, leftovers: input?.leftovers })
    return admissions.next
  }
}))

/** A plan of `paneKey` waiting on the result of the session in `awaited`. */
function waiterPlan(paneKey: string, awaited: string): SessionChain {
  return {
    id: `chain-${paneKey}`,
    sourcePaneKey: paneKey,
    sourceRowKey: JSON.stringify(['local', 'wt', paneKey]),
    worktreeId: 'wt',
    hostId: 'local',
    state: 'waiting',
    updatedAt: 1,
    steps: [],
    outcomeSet: {
      revision: 1,
      attempts: [],
      continuation: { state: 'owned' },
      outcomes: [
        {
          id: 'wait',
          revision: 1,
          status: 'pending',
          conditions: [
            {
              id: 'on_billing',
              kind: 'event',
              label: 'Billing finishes',
              target: 'Billing finishes',
              event: { source: 'session', match: 'result', ref: awaited }
            }
          ],
          evidence: [],
          dependsOn: [],
          actions: []
        }
      ]
    }
  } as unknown as SessionChain
}

let dir: string
const restore: (() => void)[] = []
const chains: SessionChain[] = []
const runtime = {
  listSessionChains: () => chains,
  resolveTerminalPane: () => ({ executionHostId: 'local' }),
  getLastAgentHookRowForPane: () => null
} as unknown as OrcaRuntimeService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steward-seams-'))
  admissions.calls.length = 0
  admissions.next = null
  restore.push(configureStewardSwitches({ readSettings: () => ({}), environment: {} }))
})
afterEach(() => {
  for (const undo of restore.splice(0).toReversed()) {
    undo()
  }
  chains.length = 0
  rmSync(dir, { recursive: true, force: true })
})

describe('the steward reads S3 session waits', () => {
  it('names the waiting pane on the awaited session, until nothing waits on it', () => {
    const cards = new StewardResultCardStore(dir)
    restore.push(registerStewardPackageSeams(runtime, cards))
    chains.push(waiterPlan('tab-w:leaf', 'tab-b:leaf'))
    expect(sessionWaitersOf(['tab-b:leaf', 'view-b'])).toEqual(['tab-w:leaf'])
    chains.length = 0
    expect(sessionWaitersOf(['tab-b:leaf'])).toEqual([])
  })

  it('meets the waiter’s wait with the awaited session’s saved result card', async () => {
    const cards = new StewardResultCardStore(dir)
    restore.push(registerStewardPackageSeams(runtime, cards))
    expect(readAwaitedSessionResult(runtime, 'tab-b:leaf')).toBeNull()
    await cards.save(
      buildStewardResultCard({
        key: 'view-b',
        paneKey: 'tab-b:leaf',
        title: 'Billing',
        goal: 'Fix billing',
        reply: 'Billing is fixed; the retry test passes.',
        changed: { files: [], branch: null },
        chains: [],
        linkedDocs: [],
        turnKey: 'turn-7',
        evidence: 'JEV resolved 0.93 · quiet 7 h',
        now: 5_000
      })
    )
    expect(readAwaitedSessionResult(runtime, 'tab-b:leaf')).toMatchObject({
      tier: 'card',
      at: 5_000,
      excerpt: 'Billing is fixed; the retry test passes.'
    })
    // A result before the waiter asked is not its result.
    expect(readAwaitedSessionResult(runtime, 'tab-b:leaf', 5_000)).toBeNull()
  })
})

describe('the pile-up detector starts S4’s automatic run', () => {
  const detector = (note: (summary: string) => void) =>
    new StewardPileupDetector({ now: () => 0, threshold: () => 1, ready: () => true, note })
  const leftover = {
    paneKey: 'tab-1:leaf',
    title: 'Parser',
    kind: 'stalled' as const,
    reason: 'nudged twice',
    since: 0
  }

  it('asks for an automatic reservation and records the run it got', async () => {
    restore.push(registerStewardPackageSeams(runtime, new StewardResultCardStore(dir)))
    admissions.next = { ok: true, reservationId: 'res-1' }
    const note = vi.fn()
    await detector(note).run([leftover])
    expect(admissions.calls).toEqual([{ source: 'automatic', leftovers: ['tab-1:leaf'] }])
    expect(note).toHaveBeenCalledWith(
      'Started a cleanup session: 1 sessions the rules could not settle (threshold 1).'
    )
  })

  it('records why none started (a skipped capacity check reads its provider)', async () => {
    restore.push(registerStewardPackageSeams(runtime, new StewardResultCardStore(dir)))
    admissions.next = { ok: false, reason: 'capacity', detail: 'capacity (codex)' }
    const note = vi.fn()
    await detector(note).run([leftover])
    expect(note).toHaveBeenCalledWith(
      'No cleanup session started (capacity (codex)): 1 sessions the rules could not settle (threshold 1).'
    )
  })
})
