import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  commitArchiveDecision,
  pendingArchiveDecisions,
  acknowledgeArchiveDecision
} from './session-transfer-archive-decisions'
const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => state.directory
}))
afterEach(() => {
  if (state.directory) {
    rmSync(state.directory, { recursive: true, force: true })
  }
})
const scope = 'omni.session-sidebar-view.v1:person'
function setup() {
  state.directory = mkdtempSync(join(tmpdir(), 'archive-decision-'))
}

describe('authoritative archive decision', () => {
  it('persists the guarded decision before returning, and later source changes cannot revoke a committed batch', () => {
    setup()
    let current = true
    expect(commitArchiveDecision('op', ['a', 'b'], scope, () => current)).toBe(true)
    current = false
    expect(pendingArchiveDecisions(scope)).toEqual([{ operationId: 'op', keys: ['a', 'b'] }])
    expect(pendingArchiveDecisions(`${scope}-different-person`)).toEqual([])
    expect(commitArchiveDecision('op', ['c'], scope, () => true)).toBe(false)
  })
  it('a revoked final guard leaves no replayable operation', () => {
    setup()
    expect(commitArchiveDecision('op', ['a'], scope, () => false)).toBe(false)
    expect(pendingArchiveDecisions(scope)).toEqual([])
  })
  it('persists projection acknowledgement, refusing a different account', () => {
    setup()
    commitArchiveDecision('op', ['a'], scope, () => true)
    expect(acknowledgeArchiveDecision(`${scope}-other`, 'op')).toBe(false)
    expect(pendingArchiveDecisions(scope)).toHaveLength(1)
    expect(acknowledgeArchiveDecision(scope, 'op')).toBe(true)
    expect(pendingArchiveDecisions(scope)).toEqual([])
    expect(acknowledgeArchiveDecision(scope, 'op')).toBe(true)
  })
})
