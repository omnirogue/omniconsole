import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { StewardPromptRequest } from '../session-manage/session-manage-unattended-admission'
import { manageEntry } from '../session-manage/session-manage-test-fixtures'
import {
  createStewardPromptBudget,
  isStewardLimitRefusal,
  settleStaleIntents,
  STEWARD_INTENT_STALE_MS
} from './steward-prompt-budget'
import { StewardStateStore, STEWARD_STATE_FILE } from './steward-state-store'

let dir: string
let store: StewardStateStore
const clock = { now: Date.parse('2026-09-25T10:00:00') }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steward-budget-'))
  store = new StewardStateStore({ directory: dir, now: () => clock.now })
})
afterEach(async () => {
  await store.flush()
  rmSync(dir, { recursive: true, force: true })
})

const source = (paneKey: string): ConversationSource => ({ worktreeId: 'w', paneKey, kind: 'pty' })

function request(kind: StewardPromptRequest['kind'], paneKey = 'p1'): StewardPromptRequest {
  return {
    context: { source: 'rules' },
    kind,
    entry: manageEntry({ paneKey, title: `Session ${paneKey}` }),
    source: source(paneKey),
    text: '[from Session steward] …'
  }
}

let turn = 0
const budget = () =>
  createStewardPromptBudget({
    store,
    now: () => clock.now,
    newId: () => `intent-${(turn += 1)}`,
    readTurnKey: async () => `turn-${turn}`,
    readEvidence: async () => `head-${turn}`
  })

const onDisk = () => JSON.parse(readFileSync(join(dir, STEWARD_STATE_FILE), 'utf8'))

describe('the steward prompt budget', () => {
  it('spends the limit and records the intent on disk before it grants anything', async () => {
    const grant = await budget()(request('prompt'))
    expect(grant.ok).toBe(true)
    const saved = onDisk()
    expect(saved.daily.prompts).toBe(1)
    expect(saved.sessions.p1.nudge).toMatchObject({ count: 1, lastAt: clock.now })
    expect(saved.intents).toHaveLength(1)
    if (grant.ok) {
      grant.settle?.(true)
    }
    await store.flush()
    expect(onDisk().intents).toEqual([])
    expect(onDisk().daily.prompts).toBe(1)
  })

  it('gives the limit back when nothing was sent', async () => {
    const grant = await budget()(request('prompt'))
    if (grant.ok) {
      grant.settle?.(false)
    }
    await store.flush()
    expect(onDisk().daily.prompts).toBe(0)
    expect(onDisk().sessions.p1.nudge).toBeUndefined()
    expect((await budget()(request('prompt'))).ok).toBe(true)
  })

  it('refuses a second nudge within 12 h, naming it a limit', async () => {
    await budget()(request('prompt'))
    const second = await budget()(request('prompt'))
    expect(second).toEqual({
      ok: false,
      reason: 'Steward limit: The steward nudged it less than 12 hours ago'
    })
    expect(isStewardLimitRefusal(second.ok ? '' : second.reason)).toBe(true)
  })

  it('has no Mac-wide cap: 70 prompts across sessions and callers are all granted and counted', async () => {
    const limits = budget()
    for (let n = 0; n < 70; n += 1) {
      const grant = await limits({
        ...request('ask', `p${n}`),
        context: n % 2 ? { source: 'cleanup-run', runId: 'run-1' } : { source: 'rules' }
      })
      expect(grant.ok).toBe(true)
    }
    expect(store.read().daily.prompts).toBe(70)
    // The per-session limit still holds.
    expect(await limits(request('ask', 'p0'))).toEqual({
      ok: false,
      reason: 'Steward limit: The steward asked it whether it is done less than 24 hours ago'
    })
  })

  it('never says yes twice on one turn', async () => {
    const limits = createStewardPromptBudget({
      store,
      now: () => clock.now,
      newId: () => `intent-${(turn += 1)}`,
      readTurnKey: async () => 'turn-fixed',
      readEvidence: async () => 'head-fixed'
    })
    expect((await limits(request('yes'))).ok).toBe(true)
    expect(await limits(request('yes'))).toEqual({
      ok: false,
      reason: 'Steward limit: The steward already answered this turn'
    })
  })

  it('settles an interrupted intent as spent, never to be resent, and records it', async () => {
    await budget()(request('yes'))
    const restarted = new StewardStateStore({ directory: dir, now: () => clock.now })
    const interrupted = restarted.load()
    expect(interrupted).toHaveLength(1)
    const settled = await restarted.transact((data) => settleStaleIntents(data, clock.now, true))
    expect(settled.map((intent) => intent.kind)).toEqual(['yes'])
    expect(restarted.read().intents).toEqual([])
    expect(restarted.read().daily.prompts).toBe(1)
    expect(restarted.read().activity.at(-1)?.summary).toMatch(/counted and is not sent again/)
  })

  it('settles a grant with no settle after 5 minutes', async () => {
    await budget()(request('ask'))
    const fresh = await store.transact((data) => settleStaleIntents(data, clock.now + 1_000))
    expect(fresh).toEqual([])
    const stale = await store.transact((data) =>
      settleStaleIntents(data, clock.now + STEWARD_INTENT_STALE_MS)
    )
    expect(stale).toHaveLength(1)
  })
})
