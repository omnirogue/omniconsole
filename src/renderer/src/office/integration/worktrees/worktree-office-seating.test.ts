import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn(), subscribe: vi.fn() } }))

import { MAX_AGENTS } from '../../data/agents'
import { WORKTREE_SET_ID } from './WorktreeOfficeBridge'

describe('the office seats workspaces, not agent types', () => {
  it('leaves room for a real working set', () => {
    // The office shipped capped at 5 because it drew one character per agent
    // TYPE. Seating one per workspace needs more chairs than that.
    expect(MAX_AGENTS).toBeGreaterThan(5)
  })

  it('claims a team id that cannot collide with a user-made team', () => {
    // The set is rebuilt from live state on every change, so a user team of the
    // same id would be silently overwritten.
    expect(WORKTREE_SET_ID).toBe('omni-worktrees')
  })
})
