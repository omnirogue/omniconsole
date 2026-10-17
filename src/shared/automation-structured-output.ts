import { z } from 'zod'
import type { Automation } from './automations-types'
import { advertisingRoutinePolicy } from './typesafe-advertising'

export const automationStructuredOutputSchema = z.discriminatedUnion('contract', [
  z
    .object({
      provider: z.literal('typesafe'),
      contract: z.literal('classification.v1')
    })
    .strict(),
  z
    .object({
      provider: z.literal('typesafe'),
      contract: z.literal('advertising.v1'),
      advertising: advertisingRoutinePolicy
    })
    .strict()
])

export type AutomationStructuredOutput = z.input<typeof automationStructuredOutputSchema>

export function assertAutomationRunAllowed(
  automation: Automation | undefined,
  promptOverride?: string
): asserts automation is Automation {
  if (!automation) {
    throw new Error('Automation not found.')
  }
  if (automation.structuredOutput && promptOverride !== undefined) {
    throw new Error(
      'Prompt overrides are unavailable for routines with structured decisions. Run the saved routine or use its validated action controls.'
    )
  }
}

/** Invalid saved settings must remain visible as an error, never silently disable the feature. */
export function parseAutomationStructuredOutput(
  value: unknown
): AutomationStructuredOutput | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  const parsed = automationStructuredOutputSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      'Invalid structured decision settings. Choose a supported result format and advertising account.'
    )
  }
  return parsed.data
}
