import type { WorkPlanDoneWhen } from './work-plan-types'

/** Every exact (plan) substring is a token, including explain(plan). */
export function stripPlanModeToken(prompt: string): { prompt: string; planMode: boolean } {
  const planMode = /\(plan\)/i.test(prompt)
  return { prompt: planMode ? prompt.replace(/\(plan\)/gi, '').trim() : prompt, planMode }
}

export function proposeOutcomeFromPrompt(prompt: string): {
  title: string
  doneWhen: WorkPlanDoneWhen[]
} {
  const text = prompt.trim()
  return {
    title: (text.split(/(?<=[.!?])\s/)[0] ?? text).slice(0, 80),
    doneWhen: [{ id: 'd1', text, evidence: 'human' }]
  }
}
