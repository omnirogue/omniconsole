import { describe, expect, it } from 'vitest'
import { jevRequestSchema, jevTrialInputSchema } from './jev-control'
import { JEV_REQUEST_RECIPES, JEV_TRIAL_RECIPES } from './jev-trial-workflow'

const states: Record<(typeof JEV_REQUEST_RECIPES)[number], Record<string, string>> = {
  advertising_review: { copy: 'Fictional copy', offer: 'Fictional offer' },
  evidence_review: { claim: 'Fictional claim', source: 'Fictional source' },
  work_routing: { task: 'Fictional task' },
  support_triage: { message: 'Fictional message' },
  retrieval_review: { query: 'Fictional query', passage: 'Fictional passage' },
  lead_fit: { lead: 'Fictional lead', criteria: 'Fictional criteria' }
}

describe('JEV request recipes', () => {
  it.each(JEV_REQUEST_RECIPES)('jev.request accepts %s with its fixed fields', (recipeId) => {
    const parsed = jevRequestSchema.parse({ input: { recipeId, state: states[recipeId] } })
    expect(parsed).toEqual({ input: { recipeId, state: states[recipeId] }, control: 'request' })
  })

  it('keeps the parked desktop trials at three recipes', () => {
    expect(JEV_TRIAL_RECIPES).toHaveLength(3)
    for (const recipeId of JEV_REQUEST_RECIPES) {
      expect(jevTrialInputSchema.safeParse({ recipeId, state: states[recipeId] }).success).toBe(
        (JEV_TRIAL_RECIPES as readonly string[]).includes(recipeId)
      )
    }
  })

  it.each([
    { recipeId: 'support_triage', state: { message: ' ' } },
    { recipeId: 'support_triage', state: { message: 'x', apiKey: 'caller-key' } },
    { recipeId: 'retrieval_review', state: { query: 'q' } },
    { recipeId: 'lead_fit', state: { lead: 'x'.repeat(6001), criteria: 'y' } },
    { recipeId: 'lead_fit', state: { lead: 'x'.repeat(6000), criteria: 'y'.repeat(6000) } }
  ])('rejects blank, extra, missing or oversized fields: %j', (input) => {
    expect(jevRequestSchema.safeParse({ input }).success).toBe(false)
  })
})
