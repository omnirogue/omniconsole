import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withLaunchClaim } from './session-launch-claim'
import { readLaunchIntent, writeLaunchIntent } from './session-launch-intent'
import { agentLaunchRecordStore, type AgentLaunchRecordStore } from './session-launch-record'

let userData = ''
let store: AgentLaunchRecordStore

function claimPath(): string {
  const intents = join(store.dir, 'intents')
  mkdirSync(intents, { recursive: true })
  return join(intents, 'intent-a.claim')
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'omni-launch-claim-'))
  store = agentLaunchRecordStore(userData)
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userData, { recursive: true, force: true })
})

describe('withLaunchClaim', () => {
  it('a concurrent invocation waits on the claim and then follows the same operation', async () => {
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((done) => (release = done))
    const first = withLaunchClaim(store, 'intent-a', async () => {
      order.push('first planning')
      await held
      writeLaunchIntent(store, 'intent-a', '1759450000000-0123456789abcdef0123456789abcdef')
      order.push('first recorded')
    })
    await new Promise((done) => setTimeout(done, 20))
    const second = withLaunchClaim(
      store,
      'intent-a',
      async () => {
        order.push('second planning')
        return readLaunchIntent(store, 'intent-a')
      },
      { pollMs: 5 }
    )
    await new Promise((done) => setTimeout(done, 30))
    expect(order).toEqual(['first planning'])
    release()
    await first
    await expect(second).resolves.toBe('1759450000000-0123456789abcdef0123456789abcdef')
    expect(order).toEqual(['first planning', 'first recorded', 'second planning'])
  })

  it("a dead claimant's claim is stolen at once", async () => {
    writeFileSync(claimPath(), JSON.stringify({ pid: 999_999, at: Date.now() }))
    const started = Date.now()
    await expect(
      withLaunchClaim(store, 'intent-a', async () => 'planned', {
        waitMs: 5_000,
        isAlive: () => false
      })
    ).resolves.toBe('planned')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('a live claimant past its stale bound remains owned', async () => {
    const claim = claimPath()
    writeFileSync(claim, JSON.stringify({ pid: process.pid + 1, at: Date.now() }))
    await expect(
      withLaunchClaim(store, 'intent-a', async () => 'planned', {
        waitMs: 30,
        pollMs: 5,
        isAlive: () => true
      })
    ).rejects.toMatchObject({ code: 'launch_busy' })
    writeFileSync(claim, JSON.stringify({ pid: process.pid + 1, at: Date.now() - 121_000 }))
    await expect(
      withLaunchClaim(store, 'intent-a', async () => 'planned', {
        waitMs: 30,
        pollMs: 5,
        isAlive: () => true
      })
    ).rejects.toMatchObject({ code: 'launch_busy' })
  })

  it('reclaims a stale claim only when a reused PID has a different process birth', async () => {
    writeFileSync(
      claimPath(),
      JSON.stringify({ pid: 99_991, at: Date.now() - 121_000, birth: 1_700_000_000_000 })
    )
    await expect(
      withLaunchClaim(store, 'intent-a', async () => 'planned', {
        isAlive: () => true,
        readBirth: async () => 1_700_000_010_000
      })
    ).resolves.toBe('planned')
    expect(existsSync(claimPath())).toBe(false)
  })

  it('rechecks the claim after an asynchronous process birth probe', async () => {
    const claim = claimPath()
    const old = { pid: 99_991, at: Date.now() - 121_000, birth: 1_700_000_000_000 }
    writeFileSync(claim, JSON.stringify(old))
    const fresh = { pid: process.pid + 1, at: Date.now(), token: 'replacement' }
    let probes = 0
    await expect(
      withLaunchClaim(store, 'intent-a', async () => 'planned', {
        waitMs: 30,
        pollMs: 5,
        isAlive: () => true,
        readBirth: async (pid) => {
          if (pid !== old.pid) {
            return null
          }
          probes += 1
          if (probes === 2) {
            writeFileSync(claim, JSON.stringify(fresh))
          }
          return old.birth + 10_000
        }
      })
    ).rejects.toMatchObject({ code: 'launch_busy' })
    expect(JSON.parse(readFileSync(claim, 'utf8'))).toEqual(fresh)
  })

  it('heartbeats a long planner and stops refreshing after it returns', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const running = withLaunchClaim(store, 'intent-a', () => held, {
      staleMs: 300,
      readBirth: async () => 1_700_000_000_000
    })
    await vi.advanceTimersByTimeAsync(0)
    const before = JSON.parse(readFileSync(claimPath(), 'utf8')) as { at: number; token: string }
    await vi.advanceTimersByTimeAsync(200)
    const during = JSON.parse(readFileSync(claimPath(), 'utf8')) as { at: number; token: string }
    expect(during.at).toBeGreaterThan(before.at)
    expect(during.token).toBe(before.token)
    release()
    await running
    await vi.advanceTimersByTimeAsync(600)
    expect(existsSync(claimPath())).toBe(false)
  })

  it('does not release a replacement claim with the same reused pid and timestamp', async () => {
    await withLaunchClaim(store, 'intent-a', async () => {
      const first = JSON.parse(readFileSync(claimPath(), 'utf8')) as { pid: number; at: number }
      writeFileSync(claimPath(), JSON.stringify({ ...first, token: 'replacement' }))
    })
    expect(JSON.parse(readFileSync(claimPath(), 'utf8'))).toMatchObject({ token: 'replacement' })
  })

  it('releases the claim and heartbeat when planning rejects', async () => {
    await expect(
      withLaunchClaim(
        store,
        'intent-a',
        async () => {
          throw new Error('canceled')
        },
        { staleMs: 300 }
      )
    ).rejects.toThrow('canceled')
    expect(existsSync(claimPath())).toBe(false)
  })

  it('steals only through the steal lock, so two waiters never both remove a claim', async () => {
    const claim = claimPath()
    const deadHolder = JSON.stringify({ pid: 999_999, at: Date.now() })
    writeFileSync(claim, deadHolder)
    // Why: another waiter is mid-steal; removing the claim now could delete the one it creates.
    writeFileSync(`${claim}.steal`, JSON.stringify({ pid: process.pid + 1, at: Date.now() }))
    const isAlive = (pid: number) => pid !== 999_999
    await expect(
      withLaunchClaim(store, 'intent-a', async () => 'planned', { waitMs: 30, pollMs: 5, isAlive })
    ).rejects.toMatchObject({ code: 'launch_busy', data: { outcome: 'not-sent' } })
    expect(readFileSync(claim, 'utf8')).toBe(deadHolder)

    // A steal lock left by a dead waiter is cleared, and the dead claim is then stolen.
    writeFileSync(`${claim}.steal`, JSON.stringify({ pid: 999_999, at: Date.now() }))
    await expect(
      withLaunchClaim(store, 'intent-a', async () => 'planned', {
        waitMs: 1_000,
        pollMs: 5,
        isAlive
      })
    ).resolves.toBe('planned')
    expect(existsSync(`${claim}.steal`)).toBe(false)
    expect(existsSync(claim)).toBe(false)
  })

  it('a waiter that judged a claim dead leaves a newer claim in its place alone', async () => {
    const claim = claimPath()
    writeFileSync(claim, JSON.stringify({ pid: 999_999, at: Date.now() }))
    const fresh = JSON.stringify({ pid: process.pid + 1, at: Date.now() + 1 })
    let replaced = false
    const isAlive = (pid: number): boolean => {
      if (pid === 999_999 && !replaced) {
        // Why: another waiter steals the dead claim and takes its own between our checks.
        replaced = true
        writeFileSync(claim, fresh)
      }
      return pid !== 999_999
    }
    await expect(
      withLaunchClaim(store, 'intent-a', async () => 'planned', { waitMs: 30, pollMs: 5, isAlive })
    ).rejects.toMatchObject({ code: 'launch_busy' })
    expect(readFileSync(claim, 'utf8')).toBe(fresh)
  })
})
