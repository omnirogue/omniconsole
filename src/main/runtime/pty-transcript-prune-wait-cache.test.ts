/**
 * Regression: the onPtyData wait-scan memoization caches a PTY's tail wait
 * state on the record (tailWaitState) and reuses it as the next chunk's
 * "previous" state. Whenever a record's terminal generation is reset — a
 * replacement daemon session reusing the same PTY id — that cache MUST be
 * dropped, or the replacement's first chunk would be compared against a stale
 * (possibly blocked) wait state and mis-stamp waitBlockedAt.
 *
 * The transcript itself is NOT discarded any more: canonical terminal output
 * has to survive exit and restart, so the retained tail is asserted to stay.
 */
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import type { TerminalTailWaitState } from './omni-runtime'

type PtyRecord = {
  connected: boolean
  tailBuffer: string[]
  waitBlockedAt: number | null
  tailWaitState?: TerminalTailWaitState
}
type RuntimeInternals = {
  recordPtyWorktree: (p: string, w: string, s?: { connected?: boolean }) => PtyRecord
  resetTrackedTerminalStateForProviderGeneration: (ptyId: string) => void
}

describe('a provider-generation reset clears the wait-scan cache', () => {
  it('drops tailWaitState so the replacement recomputes, and keeps the transcript', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals
    const pty = internals.recordPtyWorktree('pty-1', 'wt-1', { connected: true })

    // Simulate an established, blocked tail with a memoized wait state.
    pty.tailBuffer = ['Update available! Press Enter to continue.']
    pty.waitBlockedAt = 1_000
    pty.tailWaitState = {
      waitText: 'update available! press enter to continue.',
      signal: { reason: 'codex-update-prompt', index: 0 },
      fromTail: true
    }

    pty.connected = false
    internals.resetTrackedTerminalStateForProviderGeneration('pty-1')

    expect(pty.tailWaitState).toBeUndefined()
    expect(pty.waitBlockedAt).toBeNull()
    // Canonical output must outlive the dead generation.
    expect(pty.tailBuffer).toEqual(['Update available! Press Enter to continue.'])
  })
})
