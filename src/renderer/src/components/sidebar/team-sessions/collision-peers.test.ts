import { describe, expect, it } from 'vitest'
import type { LedgerLocalSession, LedgerPeer } from '@/lib/session-ledger-types'
import { collisionPeerName, eligibleCollisionPeer } from './collision-peers'
import { row } from './session-ledger-test-fixtures'

const repo = '/Users/maintainer/work/omni-ide'
const first: LedgerLocalSession = {
  paneId: 'pane-1',
  ledgerId: 'ledger-1',
  attemptId: 'attempt-1',
  repo,
  branch: 'main'
}
const second: LedgerLocalSession = { ...first, paneId: 'pane-2', ledgerId: 'ledger-2' }
const peer = (ledger_id: string, patch: Partial<LedgerPeer> = {}): LedgerPeer => ({
  ledger_id,
  employee_id: 'me',
  employee_name: 'Sal',
  reason: 'Sal is on the same branch',
  ...patch
})
const none: ReadonlySet<string> = new Set()

describe('eligibleCollisionPeer', () => {
  it('treats a second local session of the same employee as a real peer, both ways', () => {
    expect(eligibleCollisionPeer(peer('ledger-2'), first, none)).toBe(true)
    expect(eligibleCollisionPeer(peer('ledger-1'), second, none)).toBe(true)
  })
  it('rejects only the exact self ledger id', () => {
    expect(eligibleCollisionPeer(peer('ledger-1'), first, none)).toBe(false)
    // A resumed pane keeps its ledger id, so the same check covers every attempt.
    expect(
      eligibleCollisionPeer(peer('ledger-1'), { ...first, attemptId: 'attempt-9' }, none)
    ).toBe(false)
  })
  it('does not require the peer to be on the bounded now page or to carry an owner', () => {
    expect(
      eligibleCollisionPeer(
        peer('elsewhere', { employee_id: undefined, employee_name: null }),
        first,
        none
      )
    ).toBe(true)
  })
  it('rejects every peer of a muted repo', () => {
    expect(eligibleCollisionPeer(peer('ledger-2'), first, new Set([repo]))).toBe(false)
    expect(eligibleCollisionPeer(peer('ledger-2'), { ...first, repo: null }, new Set([repo]))).toBe(
      true
    )
  })
  it('never drops a server-returned peer for restricted-looking fields', () => {
    const restricted = {
      ...peer('restricted-1', { employee_id: null, employee_name: null, reason: '' }),
      restricted: true,
      visibility: 'restricted'
    } as LedgerPeer
    expect(eligibleCollisionPeer(restricted, first, none)).toBe(true)
  })
})

describe('collisionPeerName', () => {
  it('prefers the roster row, then the peer payload, then nothing', () => {
    expect(collisionPeerName(peer('p'), [row('p', { employee_name: 'Roster Sal' })])).toBe(
      'Roster Sal'
    )
    expect(collisionPeerName(peer('p'), [])).toBe('Sal')
    expect(collisionPeerName(peer('p', { employee_name: null }), [])).toBe('me')
    expect(collisionPeerName(peer('p', { employee_id: null, employee_name: null }), [])).toBeNull()
  })
  it('treats blank names as missing at every step', () => {
    expect(collisionPeerName(peer('p'), [row('p', { employee_name: '  ' })])).toBe('Sal')
    expect(collisionPeerName(peer('p', { employee_name: '' }), [])).toBe('me')
    expect(collisionPeerName(peer('p', { employee_id: ' ', employee_name: '' }), [])).toBeNull()
    expect(collisionPeerName(peer('p', { employee_name: ' Ana ' }), [])).toBe('Ana')
  })
})
