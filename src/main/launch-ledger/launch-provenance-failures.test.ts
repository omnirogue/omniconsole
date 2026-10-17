import { afterEach, describe, expect, it, vi } from 'vitest'
import * as crypto from 'node:crypto'
import * as ledger from './launch-ledger'
import * as records from './spawn-launch-record'
import * as claims from './launch-caller-claims'
import { resolveIpcSpawnLaunchCause } from '../ipc/pty/ipc/spawn-launch-attribution'
import * as hints from '../observability/launch-trigger-hints'

vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof crypto>()
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) }
})

const failure = new Error('private prompt and credential failure')
afterEach(() => {
  vi.restoreAllMocks()
  hints._resetLaunchTriggerHintsForTests()
})
function warnings() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {})
}

describe('provenance exports own their error boundaries', () => {
  it.each([
    ['prepareIpcSpawnLaunch', records.prepareIpcSpawnLaunch],
    ['prepareRuntimeSpawnLaunch', records.prepareRuntimeSpawnLaunch],
    ['recordIpcSpawnLaunch', records.recordIpcSpawnLaunch],
    ['recordRuntimeSpawnLaunch', records.recordRuntimeSpawnLaunch],
    ['recordSpawnLaunchFailure', records.recordSpawnLaunchFailure]
  ] as const)('%s cannot throw a record writer error into execution', (_name, record) => {
    const warn = warnings()
    vi.spyOn(ledger, 'recordLaunch').mockImplementation(() => {
      throw failure
    })
    const ctx = { args: {}, result: { id: 'pty-1' }, spawnIdentityPaneKey: null }
    expect(() => record(ctx as never, { id: 'pty-1' })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.flat().join()).not.toContain(failure.message)
  })

  it('a broken warning sink also cannot escape a recorder boundary', () => {
    warnings().mockImplementation(() => {
      throw failure
    })
    vi.spyOn(ledger, 'recordLaunch').mockImplementation(() => {
      throw failure
    })
    expect(() => records.prepareRuntimeSpawnLaunch({ args: {} } as never)).not.toThrow()
  })
  it('claim hashing errors resolve to unknown without exposing the error text', () => {
    const warn = warnings()
    vi.spyOn(claims, 'callerLaunchClaims').mockImplementation(() => {
      throw failure
    })
    expect(resolveIpcSpawnLaunchCause({ hasLaunchCommand: true })).toEqual({ trigger: 'unknown' })
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[launch-ledger] renderer-ipc: provenance unavailable'
    )
  })

  it.each([true, false])('hint reads guard the clock when consume=%s', (consume) => {
    const warn = warnings()
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw failure
    })
    expect(hints.takeLaunchCauseHints({ tabId: 'tab' }, undefined, consume)).toEqual({
      tabCause: null,
      worktreeCause: null
    })
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[launch-ledger] launch-hints: provenance unavailable'
    )
  })

  it('hint transfer failures do not escape into the renderer reply handler', () => {
    const warn = warnings()
    hints.noteLaunchTriggerHint({ tabId: 'before', trigger: 'cli' }, 1)
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw failure
    })
    expect(() =>
      hints.transferRendererLaunchCause({ requestedTabId: 'before', tabId: 'after' })
    ).not.toThrow()
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[launch-ledger] launch-hints: provenance unavailable'
    )
  })

  it('hint reservation is optional even when UUID generation fails', () => {
    const warn = warnings()
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw failure
    })
    expect(hints.reserveRendererLaunchCause({ hasStartupCommand: true })).toBe('')
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[launch-ledger] launch-hints: provenance unavailable'
    )
  })

  it('the compatibility hint read also guards its default clock', () => {
    const warn = warnings()
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw failure
    })
    expect(hints.takeLaunchTriggerHints({ tabId: 'tab' })).toEqual({
      tabHint: null,
      worktreeHint: null
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('producer bookkeeping does not own execution', () => {
  it.each(['add', 'delete'] as const)(
    'a broken producer %s preserves success and drains',
    async (method) => {
      const warn = warnings()
      const pending = Promise.resolve({ id: 'pty-1' })
      const original = Set.prototype[method]
      vi.spyOn(Set.prototype, method).mockImplementation(function (
        this: Set<unknown>,
        value: unknown
      ) {
        if (value === pending) {
          throw failure
        }
        return Reflect.apply(original, this, [value]) as never
      })
      const run = vi.fn(() => pending)
      expect(ledger.trackLaunchProducer(run)).toBe(pending)
      await expect(pending).resolves.toEqual({ id: 'pty-1' })
      await ledger.drainLaunchLedgerAfterProducersStop([])
      expect(run).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[launch-ledger] launch-producers: provenance unavailable'
      )
    }
  )

  it('a broken promise observer never retries work or strands a quit producer', async () => {
    const warn = warnings()
    const pending = Promise.resolve('result')
    vi.spyOn(pending, 'then').mockImplementationOnce(() => {
      throw failure
    })
    let calls = 0
    const run = () => {
      calls++
      return pending
    }
    expect(ledger.trackLaunchProducer(run)).toBe(pending)
    expect(await pending).toBe('result')
    await ledger.drainLaunchLedgerAfterProducersStop([])
    expect(calls).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('preserves a producer rejection rather than swallowing or replacing execution errors', async () => {
    warnings()
    const pending = Promise.reject(failure)
    const run = vi.fn(() => pending)
    await expect(ledger.trackLaunchProducer(run)).rejects.toBe(failure)
    await ledger.drainLaunchLedgerAfterProducersStop([])
    expect(run).toHaveBeenCalledOnce()
  })
})
