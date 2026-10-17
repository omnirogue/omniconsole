import { expect, it } from 'vitest'
import { artifactProposalSchema } from './artifact-proposal'

it('rejects malformed and credential-bearing evidence without throwing from refinement', () => {
  for (const plan_url of [
    'bad',
    'https://evil.test/app/docs/a',
    'https://sal:secret@example.slite.com/app/docs/a'
  ]) {
    expect(artifactProposalSchema.safeParse({ version: 1, kind: 'plan', plan_url }).success).toBe(
      false
    )
  }
  expect(
    artifactProposalSchema.safeParse({ version: 1, kind: 'plan', approved: true }).success
  ).toBe(false)
  expect(
    artifactProposalSchema.safeParse({
      version: 1,
      kind: 'plan',
      plan_url: 'https://example.slite.com/app/docs/X3P_WfcLxXPaiG'
    }).success
  ).toBe(true)
})

it('accepts only the approval kinds; a question is not a proposal kind', () => {
  for (const kind of ['plan', 'customer_send', 'ad_launch', 'budget', 'deployment', 'other']) {
    expect(artifactProposalSchema.safeParse({ version: 1, kind }).success).toBe(true)
  }
  for (const kind of ['question', 'presentation_only', 'lander_draft']) {
    expect(artifactProposalSchema.safeParse({ version: 1, kind }).success).toBe(false)
  }
})
