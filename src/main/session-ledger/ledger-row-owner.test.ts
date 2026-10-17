import { describe, expect, it } from 'vitest'
import { LedgerPaneRegistry } from './ledger-identity'
import { LEDGER_REMOVED_ROW_MEMORY_MS, LedgerOwnerLedger, needsOwnRow } from './ledger-row-owner'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function ownerlessRow() {
  const registry = new LedgerPaneRegistry()
  const owners = new LedgerOwnerLedger()
  const { entry } = registry.stamp(PANE, { ptyId: 'pty-1' })
  return { registry, owners, entry }
}

describe('row ownership', () => {
  it('lets the sole principal seen since the stamp claim a row this run opened while signed out', () => {
    const { registry, owners, entry } = ownerlessRow()
    owners.stamped(PANE)
    owners.observe('A')
    expect(owners.claim(registry, entry.ledgerId, 'B')).toBe(false)
    expect(owners.claim(registry, entry.ledgerId, 'A')).toBe(true)
    expect(registry.get(PANE)?.account).toBe('A')
    // Owned rows answer by comparison only.
    expect(owners.claim(registry, entry.ledgerId, 'B')).toBe(false)
  })

  it('refuses both people when a known account returns after the stamp (A, B, stamp, A, B)', () => {
    const { registry, owners, entry } = ownerlessRow()
    owners.observe('A')
    owners.observe('B')
    owners.stamped(PANE)
    owners.observe('A')
    owners.observe('B')
    expect(owners.claim(registry, entry.ledgerId, 'B')).toBe(false)
    expect(owners.claim(registry, entry.ledgerId, 'A')).toBe(false)
    expect(registry.get(PANE)?.account).toBeNull()
  })

  it('refuses both people when the first post-stamp sighting equals the pre-stamp one (A, null, stamp, A, B)', () => {
    const { registry, owners, entry } = ownerlessRow()
    owners.observe('A')
    owners.observe(null)
    owners.stamped(PANE)
    owners.observe('A')
    owners.observe('B')
    expect(owners.claim(registry, entry.ledgerId, 'B')).toBe(false)
    expect(owners.claim(registry, entry.ledgerId, 'A')).toBe(false)
    expect(registry.get(PANE)?.account).toBeNull()
  })

  it('refuses both people seen after the stamp in either order (stamp, B, A)', () => {
    const { registry, owners, entry } = ownerlessRow()
    owners.stamped(PANE)
    owners.observe('B')
    owners.observe('A')
    expect(owners.claim(registry, entry.ledgerId, 'A')).toBe(false)
    expect(owners.claim(registry, entry.ledgerId, 'B')).toBe(false)
  })

  it('lets the same person claim after signing out and back in around and after the stamp', () => {
    const before = ownerlessRow()
    before.owners.observe('A')
    before.owners.observe(null)
    before.owners.stamped(PANE)
    before.owners.observe('A')
    expect(before.owners.claim(before.registry, before.entry.ledgerId, 'A')).toBe(true)

    const after = ownerlessRow()
    after.owners.stamped(PANE)
    after.owners.observe('A')
    after.owners.observe(null)
    after.owners.observe('A')
    expect(after.owners.claim(after.registry, after.entry.ledgerId, 'A')).toBe(true)
  })

  it('treats signing out and back in as the same person, and a PTY exit as no obstacle', () => {
    const { registry, owners, entry } = ownerlessRow()
    owners.stamped(PANE)
    owners.observe('A')
    owners.observe(null)
    owners.observe('A')
    registry.update(PANE, { ptyId: null, ended: true })
    expect(owners.claim(registry, entry.ledgerId, 'A')).toBe(true)
  })

  it('never claims a row it did not stamp this run, nor a restored one', () => {
    const { registry, owners, entry } = ownerlessRow()
    owners.observe('A')
    expect(owners.claim(registry, entry.ledgerId, 'A')).toBe(false)
    owners.stamped(PANE)
    registry.update(PANE, { restored: true })
    expect(owners.claim(registry, entry.ledgerId, 'A')).toBe(false)
    registry.update(PANE, { restored: false, attemptId: '' })
    expect(owners.claim(registry, entry.ledgerId, 'A')).toBe(false)
  })

  it('remembers a removed row for the age-out window so its batches are not orphaned at once', () => {
    const { registry, owners, entry } = ownerlessRow()
    owners.stamped(PANE)
    registry.remove(PANE)
    owners.forget(PANE, entry.ledgerId, 1_000)
    expect(owners.rowKnown(registry, entry.ledgerId, 1_000 + LEDGER_REMOVED_ROW_MEMORY_MS)).toBe(
      true
    )
    expect(owners.rowKnown(registry, entry.ledgerId, 1_001 + LEDGER_REMOVED_ROW_MEMORY_MS)).toBe(
      false
    )
    expect(owners.rowKnown(registry, 'als_ffffffffffffffffffffffff')).toBe(false)
  })

  it('splits a spawn away from a foreign or unclaimable row, but not from its own re-stamp', () => {
    const base = { account: null, ptyId: 'pty-1', pendingStart: 'session_start' as const }
    expect(needsOwnRow(base, 'A', 'pty-1')).toBe(false)
    expect(needsOwnRow(base, 'A', 'pty-2')).toBe(true)
    expect(needsOwnRow({ ...base, pendingStart: null }, 'A', 'pty-1')).toBe(true)
    expect(needsOwnRow({ ...base, account: 'A' }, 'A', 'pty-2')).toBe(false)
    expect(needsOwnRow({ ...base, account: 'B' }, 'A', 'pty-2')).toBe(true)
  })
})
