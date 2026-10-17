import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseStewardState,
  stewardDay,
  StewardStateStore,
  STEWARD_STATE_FILE
} from './steward-state-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steward-state-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the steward state store', () => {
  it('keeps limits, Stalled and activity across a restart', async () => {
    const store = new StewardStateStore({ directory: dir, now: () => 1_000 })
    await store.transact((data) => {
      data.sessions.p1 = {
        title: 'Parser',
        stalled: { at: 900, reason: 'nudged twice' },
        updatedAt: 1_000
      }
      data.daily = { day: stewardDay(1_000), prompts: 3 }
    })
    await store.note({ kind: 'nudge', paneKey: 'p1', summary: 'Queued a prompt.' })
    const reopened = new StewardStateStore({ directory: dir, now: () => 2_000 })
    expect(reopened.load()).toEqual([])
    expect(reopened.session('p1')?.stalled).toEqual({ at: 900, reason: 'nudged twice' })
    expect(reopened.read().daily.prompts).toBe(3)
    expect(reopened.read().activity).toEqual([
      { kind: 'nudge', paneKey: 'p1', summary: 'Queued a prompt.', at: 1_000 }
    ])
  })

  it('leaves the state as it was when a save fails, and rejects', async () => {
    writeFileSync(join(dir, 'blocker'), 'not a directory')
    const store = new StewardStateStore({
      directory: join(dir, 'blocker', 'steward'),
      now: () => 1
    })
    await expect(
      store.transact((data) => {
        data.daily.prompts = 2
      })
    ).rejects.toThrow()
    expect(store.read().daily.prompts).toBe(0)
  })

  it('drops what it cannot read and starts empty on a damaged file', () => {
    writeFileSync(join(dir, STEWARD_STATE_FILE), '{not json')
    const store = new StewardStateStore({ directory: dir, now: () => 1 })
    expect(store.load()).toEqual([])
    expect(store.read().sessions).toEqual({})
    const parsed = parseStewardState(
      {
        sessions: { good: { updatedAt: 1 }, bad: 'x' },
        intents: [{ id: 'i', paneKey: 'p', kind: 'yes', at: 1 }, { id: 2 }],
        activity: [
          { at: 1, kind: 'nudge', summary: 's' },
          { at: 1, kind: 'launch', summary: 's' }
        ]
      },
      1
    )
    expect(Object.keys(parsed.sessions)).toEqual(['good'])
    expect(parsed.intents).toHaveLength(1)
    expect(parsed.activity).toHaveLength(1)
  })

  it('keeps at most 500 sessions, dropping the least recently updated', async () => {
    const store = new StewardStateStore({ directory: dir, now: () => 1 })
    await store.transact((data) => {
      for (let n = 0; n < 510; n += 1) {
        data.sessions[`p${n}`] = { updatedAt: n }
      }
    })
    const keys = Object.keys(store.read().sessions)
    expect(keys).toHaveLength(500)
    expect(keys).not.toContain('p0')
    expect(keys).toContain('p509')
  })
})
