import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrganizationChange } from '../../shared/session-organization-change'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { listSessionManageEntries } from '../session-manage/session-manage-inventory'
import { observeSources, sidebarRow } from '../session-manage/session-manage-test-fixtures'
import {
  setStewardPolicyHooks,
  stewardTier2Verdict,
  STEWARD_TIER2_UNAVAILABLE
} from '../session-manage/session-manage-unattended-admission'
import { sessionOrganizationLedgerFor } from '../session-organization/organization-change-ledger'
import { buildStewardResultCard, StewardResultCardStore } from './steward-result-card'
import { getSessionSteward, startSessionSteward } from './steward-runtime'
import { STEWARD_DIRECTORY, StewardStateStore } from './steward-state-store'
import { configureStewardSwitches } from './steward-switches'

let dir: string
const cleanups: (() => void)[] = []
const settings: Record<string, unknown> = {}
const env: Record<string, string | undefined> = {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steward-runtime-'))
  cleanups.push(configureStewardSwitches({ readSettings: () => settings, environment: env }))
})
afterEach(async () => {
  while (cleanups.length) {
    cleanups.pop()!()
  }
  await sessionOrganizationLedgerFor(dir).flush()
  rmSync(dir, { recursive: true, force: true })
})

function start(organize?: () => Promise<unknown>) {
  const stop = startSessionSteward({
    runtime: {} as OrcaRuntimeService,
    store: { getSettings: () => ({}) } as unknown as Store,
    userDataPath: dir,
    ...(organize ? { organize } : {})
  })
  return stop
}

function card(key: string, builtAt: number) {
  return buildStewardResultCard({
    key,
    paneKey: `pane-${key}`,
    title: `Session ${key}`,
    goal: null,
    reply: 'Done.',
    changed: null,
    chains: [],
    linkedDocs: [],
    evidence: 'JEV resolved 0.9 · quiet 7 h',
    now: builtAt
  })
}

async function applied(kind: 'archive' | 'unarchive', key: string, opId: string) {
  const ledger = sessionOrganizationLedgerFor(dir)
  const change: OrganizationChange = {
    opId,
    kind,
    targets: [{ sessionKey: key }],
    value: kind === 'archive',
    executor:
      kind === 'archive' ? { kind: 'app', feature: 'steward' } : { kind: 'person', via: 'work' },
    reason: 'finished, not verified'
  }
  if (kind === 'archive') {
    await ledger.prepare(change, {})
  }
  await ledger.settle({
    phase: 'applied',
    change,
    before: [kind !== 'archive'],
    after: [kind === 'archive']
  })
}

describe('the steward on this host', () => {
  it('drives Phase 3 organizing after every rules pass, even a failed one, never while off', async () => {
    let organized = 0
    const stop = start(async () => {
      organized += 1
      throw new Error('no window')
    })
    cleanups.push(() => void stop())
    // This runtime reads nothing, so the rules pass itself fails; organizing still runs.
    await getSessionSteward()!.pass()
    await getSessionSteward()!.pass()
    expect(organized).toBe(2)
    settings.enabled = false
    await getSessionSteward()!.pass()
    expect(organized).toBe(2)
    delete settings.enabled
  })

  it('registers its Tier 2 and prompt-limit checks while it runs, and removes them on stop', async () => {
    const stop = start()
    expect(getSessionSteward()).not.toBeNull()
    // The check is registered: an unknown target is refused by it, not by the missing hook.
    const running = await stewardTier2Verdict({ source: 'rules' }, { paneKey: 'p1' }).catch(
      (error: Error) => ({ ok: false as const, reason: error.message })
    )
    expect(running.ok ? '' : running.reason).not.toBe(STEWARD_TIER2_UNAVAILABLE)
    await stop()
    expect(getSessionSteward()).toBeNull()
    expect(await stewardTier2Verdict({ source: 'rules' }, { paneKey: 'p1' })).toEqual({
      ok: false,
      reason: STEWARD_TIER2_UNAVAILABLE
    })
  })

  it('shows the cards of archives that still stand, newest first, and drops one Undo reversed', async () => {
    const cards = new StewardResultCardStore(dir)
    const before = Date.now() - 1_000
    await cards.save(card('kept', before))
    await cards.save(card('undone', before + 1))
    await cards.save(card('never-archived', before + 2))
    await applied('archive', 'kept', 'op-kept')
    await applied('archive', 'undone', 'op-undone')
    await applied('unarchive', 'undone', 'op-undo')
    const stop = start()
    const shown = await getSessionSteward()!.finished()
    expect(shown.map((entry) => [entry.key, entry.opId])).toEqual([['kept', 'op-kept']])
    expect(shown[0]!.archivedAt).toBeGreaterThanOrEqual(before)
    expect(await getSessionSteward()!.finished(Date.now() + 60_000)).toEqual([])
    await stop()
  })

  it('reports Stalled, today’s prompts and the switch that stops it', async () => {
    const state = new StewardStateStore({ directory: join(dir, STEWARD_DIRECTORY) })
    await state.transact((data) => {
      data.sessions['tab-1:leaf-1'] = {
        title: 'Parser fix',
        stalled: { at: 5, reason: 'nudged 2 times and it still has work left.' },
        updatedAt: 5
      }
    })
    const stop = start()
    const status = getSessionSteward()!.status()
    expect(status.off).toBeNull()
    expect(status.stalled).toEqual([
      {
        paneKey: 'tab-1:leaf-1',
        title: 'Parser fix',
        at: 5,
        reason: 'nudged 2 times and it still has work left.'
      }
    ])
    expect(status.prompts).toEqual({ today: 0 })
    env.OMNI_STEWARD_DISABLED = '1'
    expect(getSessionSteward()!.status().off).toMatch(/OMNI_STEWARD_DISABLED/)
    delete env.OMNI_STEWARD_DISABLED
    await stop()
  })

  it('adds Stalled to omni session list while it holds', async () => {
    const state = new StewardStateStore({ directory: join(dir, STEWARD_DIRECTORY) })
    await state.transact((data) => {
      data.sessions['tab-1:leaf-1'] = {
        title: 'Parser fix',
        stalled: { at: 5, reason: 'its reply ends on a question', turnKey: 'turn-now' },
        updatedAt: 5
      }
    })
    const stop = start()
    // No next-steps host here, so the latest turn is unread: Stalled still holds.
    const [entry] = await listSessionManageEntries([sidebarRow()], observeSources())
    expect(entry!.stalled).toEqual({ at: 5, reason: 'its reply ends on a question' })
    await stop()
    const [after] = await listSessionManageEntries([sidebarRow()], observeSources())
    expect(after!.stalled).toBeUndefined()
  })

  it('leaves the hooks S1 installed earlier in place once stopped', async () => {
    const earlier = async () => ({ ok: true as const, evidence: 'earlier' })
    cleanups.push(setStewardPolicyHooks({ tier2Eligibility: earlier }))
    const stop = start()
    await stop()
    expect(await stewardTier2Verdict({ source: 'rules' }, { paneKey: 'p1' })).toEqual({
      ok: true,
      evidence: 'earlier'
    })
  })
})
