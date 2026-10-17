import { describe, expect, it } from 'vitest'
import { makeCandidate } from '../../components/workspace-cleanup/workspace-cleanup-presentation-fixtures'
import { hasWorkspaceCleanupRiskEscalated } from './workspace-cleanup-preflight-failures'

describe('hasWorkspaceCleanupRiskEscalated (PR4 review R4, N2)', () => {
  const approved = makeCandidate()

  it.each(['running-terminal', 'live-agent', 'terminal-liveness-unknown', 'unknown-base'] as const)(
    'asks again when %s appears after the confirmation',
    (blocker) => {
      expect(
        hasWorkspaceCleanupRiskEscalated(makeCandidate({ blockers: [blocker] }), approved)
      ).toBe(true)
    }
  )

  it('does not ask again for running work the person already confirmed', () => {
    const running = makeCandidate({ blockers: ['running-terminal'] })
    expect(hasWorkspaceCleanupRiskEscalated(running, running)).toBe(false)
  })
})
