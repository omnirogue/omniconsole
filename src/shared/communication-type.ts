import { z } from 'zod'

export const COMMUNICATION_TYPES = [
  'decision',
  'request',
  'question',
  'plan',
  'information'
] as const
export const communicationType = z.enum(COMMUNICATION_TYPES)
export type CommunicationType = z.infer<typeof communicationType>

/** Expectations travel with the existing message, independently of any task lifecycle. */
export const communicationExpectation: Record<CommunicationType, string> = {
  decision: 'Choose an option',
  request: 'Take action',
  question: 'Reply',
  plan: 'Review the plan',
  information: 'No response needed'
}
