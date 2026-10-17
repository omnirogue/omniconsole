export const JEV_TRIAL_RECIPES = ['advertising_review', 'evidence_review', 'work_routing'] as const
/** `omni jev request` serves every archived v1 recipe; the desktop trials stay at three. */
export const JEV_REQUEST_RECIPES = [
  ...JEV_TRIAL_RECIPES,
  'support_triage',
  'retrieval_review',
  'lead_fit'
] as const

export type JevTrialRecipeId = (typeof JEV_TRIAL_RECIPES)[number]
export type JevRequestRecipeId = (typeof JEV_REQUEST_RECIPES)[number]

export type JevTrialAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | {
      type: 'score'
      score: number
      confidence: number
      probabilities: Record<string, number>
      legend: Record<string, string | object>
    }
  | { type: 'noul'; noul: number }

export type JevTrialResult =
  | {
      status: 'success'
      disposition: 'advisory' | 'review'
      model: string
      elapsedMs: number
      inputHash: string
      answers: Record<string, JevTrialAnswer>
      usage: { inputTokens: number; outputTokens: number }
    }
  | {
      status: 'unavailable'
      disposition: 'review'
      reason: string
      elapsedMs: number
      inputHash: string
      answers: Record<string, never>
    }
