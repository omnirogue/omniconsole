import { describe, expect, it } from 'vitest'
import { ATTEMPT_ID_PATTERN, LEDGER_ID_PATTERN } from '../../shared/session-ledger-contract'
import {
  LEDGER_PANE_REGISTRY_MAX,
  LedgerPaneRegistry,
  ledgerIdForPane,
  ledgerIdForSession,
  mintAttemptId,
  mintLedgerId,
  OMNI_LEDGER_ATTEMPT_ID_ENV,
  OMNI_LEDGER_SESSION_ID_ENV,
  setActiveLedgerPaneRegistry,
  type LedgerPaneStore
} from './ledger-identity'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function memoryStore(): LedgerPaneStore & { saved: unknown[] } {
  let persisted: ReturnType<LedgerPaneStore['load']> = []
  const store = {
    saved: [] as unknown[],
    load: () => persisted,
    save: (entries: ReturnType<LedgerPaneStore['load']>) => {
      persisted = entries
      store.saved.push(entries)
    }
  }
  return store
}

describe('ledger ids', () => {
  it('mint the contract shapes', () => {
    expect(mintLedgerId()).toMatch(LEDGER_ID_PATTERN)
    expect(mintAttemptId()).toMatch(ATTEMPT_ID_PATTERN)
    expect(mintLedgerId()).not.toBe(mintLedgerId())
  })
})

describe('pane registry', () => {
  it('stamps a new pane with a session start and both env vars', () => {
    const registry = new LedgerPaneRegistry()
    const { entry, resumed, env } = registry.stamp(PANE, {
      ptyId: 'pty-1',
      cwd: '/repo'
    })
    expect(resumed).toBe(false)
    expect(entry.pendingStart).toBe('session_start')
    expect(env[OMNI_LEDGER_SESSION_ID_ENV]).toBe(entry.ledgerId)
    expect(env[OMNI_LEDGER_ATTEMPT_ID_ENV]).toBe(entry.attemptId)
  })

  it('keeps the ledger id across a resume in the same pane and mints a new attempt', () => {
    const registry = new LedgerPaneRegistry()
    const first = registry.stamp(PANE, { ptyId: 'pty-1' })
    registry.update(PANE, { started: true, pendingStart: null })
    const second = registry.stamp(PANE, { ptyId: 'pty-2' })
    expect(second.resumed).toBe(true)
    expect(second.entry.ledgerId).toBe(first.entry.ledgerId)
    expect(second.entry.attemptId).not.toBe(first.entry.attemptId)
    expect(second.entry.pendingStart).toBe('attempt_start')
  })

  it('still owes session_start when a pane is re-stamped before its first start went out', () => {
    // Why: the PTY died (or was replaced) before any hook; the row has never been announced.
    const registry = new LedgerPaneRegistry()
    const first = registry.stamp(PANE, { ptyId: 'pty-1' })
    const second = registry.stamp(PANE, { ptyId: 'pty-2' })
    expect(second.entry.ledgerId).toBe(first.entry.ledgerId)
    expect(second.entry.attemptId).not.toBe(first.entry.attemptId)
    expect(second.entry.pendingStart).toBe('session_start')
  })

  it('opens a new attempt through ensure() only for hooks after the attempt ended', () => {
    const registry = new LedgerPaneRegistry()
    const first = registry.stamp(PANE, { ptyId: 'pty-1' })
    registry.update(PANE, { started: true, pendingStart: null, ended: true })
    expect(registry.ensure(PANE, { reopenEnded: false })).toBe(first.entry)
    const reopened = registry.ensure(PANE, { reopenEnded: true })
    expect(reopened.ledgerId).toBe(first.entry.ledgerId)
    expect(reopened.attemptId).not.toBe(first.entry.attemptId)
    expect(reopened.ptyId).toBe('pty-1')
    expect(reopened.ended).toBe(false)
    expect(reopened.pendingStart).toBe('attempt_start')
    expect(reopened.attemptReason).toBe('reconnect')
    expect(registry.ensure(PANE, { reopenEnded: true })).toBe(reopened)
  })

  it('persists and restores the account a row was opened under, and keeps pre-store panes', () => {
    const store = memoryStore()
    const before = new LedgerPaneRegistry(store)
    const original = before.stamp(PANE, { ptyId: 'pty-1' })
    before.update(PANE, { account: 'principal-a' })

    const after = new LedgerPaneRegistry()
    const early = after.stamp('tab-9:early', { ptyId: 'pty-2' })
    after.attachStore(store)
    expect(after.get(PANE)?.ledgerId).toBe(original.entry.ledgerId)
    expect(after.get(PANE)?.account).toBe('principal-a')
    expect(after.get('tab-9:early')).toBe(early.entry)
    expect(after.byLedgerId(original.entry.ledgerId)?.paneKey).toBe(PANE)
  })

  it("lists only the owner's rows under an owner filter, and everything without one", () => {
    const registry = new LedgerPaneRegistry()
    registry.stamp(PANE, { ptyId: 'pty-1' })
    registry.update(PANE, { started: true, pendingStart: null, account: 'principal-a' })
    registry.stamp('tab-2:ownerless', { ptyId: 'pty-2' })
    registry.update('tab-2:ownerless', { started: true, pendingStart: null })
    expect(registry.localSessions()).toHaveLength(2)
    // Why: a signed-in person sees only their own rows — never an ownerless one, which they
    // could otherwise mark (and so claim) through setWaiting.
    expect(registry.localSessions('principal-a').map((row) => row.paneId)).toEqual([PANE])
    expect(registry.localSessions('principal-b')).toEqual([])
    expect(registry.localSessions(null).map((row) => row.paneId)).toEqual(['tab-2:ownerless'])
  })

  it('answers the same ids when the same PTY is stamped twice before its attempt starts', () => {
    const registry = new LedgerPaneRegistry()
    const first = registry.stamp(PANE, { ptyId: 'pty-1' })
    const again = registry.stamp(PANE, { ptyId: 'pty-1' })
    expect(again.entry.attemptId).toBe(first.entry.attemptId)
    expect(again.env).toEqual(first.env)
  })

  it('resumes a persisted pane after a restart with the stored ledger id', () => {
    const store = memoryStore()
    const before = new LedgerPaneRegistry(store)
    const original = before.stamp(PANE, { ptyId: 'pty-1' })
    before.update(PANE, { repo: 'github.com/Org/Repo', branch: 'main' })

    const after = new LedgerPaneRegistry(store)
    expect(after.localSessions()).toEqual([])
    const restored = after.stamp(PANE, { ptyId: 'pty-9' })
    expect(restored.resumed).toBe(true)
    expect(restored.entry.ledgerId).toBe(original.entry.ledgerId)
    expect(restored.entry.pendingStart).toBe('attempt_start')
    expect(restored.entry.repo).toBe('github.com/Org/Repo')
  })

  it('lists only started, unended panes as local sessions and notifies on lifecycle changes', () => {
    const registry = new LedgerPaneRegistry()
    const seen: number[] = []
    registry.subscribe((rows) => seen.push(rows.length))
    registry.stamp(PANE, { ptyId: 'pty-1' })
    expect(registry.localSessions()).toEqual([])
    registry.update(PANE, { started: true, pendingStart: null })
    expect(registry.localSessions()).toHaveLength(1)
    registry.update(PANE, { ended: true })
    expect(registry.localSessions()).toEqual([])
    expect(seen).toEqual([0, 1, 0])
  })

  it('finds panes for a tab and drops them on removal', () => {
    const registry = new LedgerPaneRegistry()
    registry.stamp(PANE)
    registry.stamp('tab-2:22222222-2222-4222-8222-222222222222')
    expect(registry.panesForTab('tab-1').map((entry) => entry.paneKey)).toEqual([PANE])
    registry.remove(PANE)
    expect(registry.get(PANE)).toBeUndefined()
  })

  it('stays bounded', () => {
    const registry = new LedgerPaneRegistry()
    for (let index = 0; index < LEDGER_PANE_REGISTRY_MAX + 5; index += 1) {
      registry.stamp(`tab-${index}:leaf`)
    }
    expect(registry.get('tab-0:leaf')).toBeUndefined()
    expect(registry.get(`tab-${LEDGER_PANE_REGISTRY_MAX + 4}:leaf`)).toBeDefined()
  })

  it('exposes pane, PTY and native-session lookups for other lanes', () => {
    const registry = new LedgerPaneRegistry()
    setActiveLedgerPaneRegistry(registry)
    try {
      const { entry } = registry.stamp(PANE, { ptyId: 'pty-7' })
      registry.update(PANE, { nativeSessionId: 'claude-uuid' })
      expect(ledgerIdForPane(PANE)).toBe(entry.ledgerId)
      expect(ledgerIdForSession('pty-7')).toBe(entry.ledgerId)
      expect(ledgerIdForSession('claude-uuid')).toBe(entry.ledgerId)
      expect(ledgerIdForSession('unknown')).toBeNull()
    } finally {
      setActiveLedgerPaneRegistry(null)
    }
    expect(ledgerIdForPane(PANE)).toBeNull()
  })
})
