import { expect, it } from 'vitest'
import {
  needsGitPatchEquivalenceProbe,
  shouldForcePushWithLeaseForUpstream
} from '../../shared/git-upstream-status'
import { getPublishTargetStatus } from '../../shared/git-publish-target-status'

it('keeps unknown patch equivalence conservative without repeatedly requesting the probe', () => {
  const status = { hasUpstream: true, ahead: 2, behind: 3, patchEquivalenceUnknown: true as const }
  expect(shouldForcePushWithLeaseForUpstream(status)).toBe(false)
  expect(needsGitPatchEquivalenceProbe(status)).toBe(false)
  expect(needsGitPatchEquivalenceProbe({ hasUpstream: true, ahead: 2, behind: 3 })).toBe(true)
})

it('preserves explicit unknown for a selected publish target without setting the old boolean', async () => {
  const result = await getPublishTargetStatus(
    async (args) => ({ stdout: args[0] === 'rev-list' ? '2\t3\n' : '' }),
    { remoteName: 'fork', branchName: 'main' },
    async () => 'unknown'
  )
  expect(result).toEqual({
    hasUpstream: true,
    upstreamName: 'fork/main',
    ahead: 2,
    behind: 3,
    patchEquivalenceUnknown: true
  })
})
