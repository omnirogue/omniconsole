import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFileModule from '../../shared/secure-file'
import { flushLedgerPaneStores, jsonFileStore, paneFileStore } from './ledger-disk-stores'
import { LedgerEventQueue } from './ledger-event-queue'

const { writeSecureFileSpy } = vi.hoisted(() => ({ writeSecureFileSpy: vi.fn() }))

vi.mock('../../shared/secure-file', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFileModule>()
  writeSecureFileSpy.mockImplementation(actual.writeSecureFile)
  return { ...actual, writeSecureFile: writeSecureFileSpy }
})

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-store-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  writeSecureFileSpy.mockClear()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('ledger json file store', () => {
  it('round-trips a value and reads an absent file as null', () => {
    const store = jsonFileStore(join(scratch(), 'queue.json'))
    expect(store.read()).toBeNull()
    store.write({ version: 2, batches: [] })
    expect(store.read()).toEqual({ version: 2, batches: [] })
    store.remove()
    expect(store.read()).toBeNull()
  })

  it('sets a truncated spill aside as .corrupt-<ts> and reads it as absent, so the next start proceeds', async () => {
    const dir = scratch()
    const path = join(dir, 'queue.json')
    writeFileSync(path, '{"version":2,"batches":[{"account":"a","batch":{"ledger_id":"als_')
    const store = jsonFileStore(path)
    expect(store.read()).toBeNull()
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(dir).some((name) => /^queue\.json\.corrupt-\d+$/.test(name))).toBe(true)

    // The queue's drain over the same store neither throws nor wedges.
    const queue = new LedgerEventQueue({ send: async () => ({ ok: true }), spill: store })
    await expect(queue.drainSpill()).resolves.toBeUndefined()
    expect(store.read()).toBeNull()
  })

  it('quarantines an unreadable (wrong-version) spill instead of deleting it', async () => {
    const dir = scratch()
    const path = join(dir, 'queue.json')
    writeFileSync(path, JSON.stringify({ version: 1, batches: [] }))
    const store = jsonFileStore(path)
    const queue = new LedgerEventQueue({ send: async () => ({ ok: true }), spill: store })
    await queue.drainSpill()
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(dir).some((name) => /^queue\.json\.unreadable-\d+$/.test(name))).toBe(true)
  })
})

describe('ledger pane file store', () => {
  const pane = (paneKey: string) => ({
    paneKey,
    ledgerId: `als_${'a'.repeat(24)}`,
    startedAt: '2026-09-28T00:00:00.000Z'
  })

  it('never rewrites the file for a save identical to what is on disk', () => {
    vi.useFakeTimers()
    const path = join(scratch(), 'panes.json')
    const first = paneFileStore(path)
    first.save([pane('tab:1')])
    vi.advanceTimersByTime(60_000)
    expect(writeSecureFileSpy).toHaveBeenCalledTimes(1)

    // A restart that re-saves the loaded registry unchanged, then repeated identical hook saves.
    const reopened = paneFileStore(path)
    expect(reopened.load()).toEqual([pane('tab:1')])
    for (let i = 0; i < 40; i++) {
      reopened.save([pane('tab:1')])
      vi.advanceTimersByTime(1_500)
    }
    expect(writeSecureFileSpy).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of changing saves into one write within the debounce window', () => {
    vi.useFakeTimers()
    const path = join(scratch(), 'panes.json')
    const store = paneFileStore(path)
    for (let i = 0; i < 20; i++) {
      store.save([pane(`tab:${i}`)])
      vi.advanceTimersByTime(20)
    }
    expect(writeSecureFileSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(writeSecureFileSpy).toHaveBeenCalledTimes(1)
    expect(paneFileStore(path).load()).toEqual([pane('tab:19')])
  })

  it('flushes a pending save on quit', () => {
    vi.useFakeTimers()
    const path = join(scratch(), 'panes.json')
    paneFileStore(path).save([pane('tab:quit')])
    expect(existsSync(path)).toBe(false)
    flushLedgerPaneStores()
    expect(paneFileStore(path).load()).toEqual([pane('tab:quit')])
  })
})
