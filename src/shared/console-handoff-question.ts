/**
 * An agent's question to a person on a handoff (hub `handoff_asks`): it stays in Work → Needs you
 * until the hub's decide write answers it (`POST /api/decisions/{id}/decide`). A reply, a done
 * entry or completing the card leaves it open, so Work answers it here.
 */

import { z } from 'zod'

/** The hub's decision id (`new_id('dcn')`). */
export const HANDOFF_DECISION_ID = /^dcn_[A-Za-z0-9]{1,64}$/

const OPTION_TEXT_MAX = 200
const OPTIONS_MAX = 10

export type HandoffQuestionOption = { label: string; value: string }

export type ConsoleHandoffQuestionDecideRequest = {
  decisionId: string
  /** `reply` picks one of the question's options; `deny` says it is no longer needed. */
  action: 'reply' | 'deny'
  value?: string
  note?: string
}

export type ConsoleHandoffQuestionDecision = { id: string; status: string }

export const handoffQuestionDecideRequest = z
  .object({
    decisionId: z.string().regex(HANDOFF_DECISION_ID),
    action: z.enum(['reply', 'deny']),
    value: z.string().min(1).max(OPTION_TEXT_MAX).optional(),
    note: z.string().max(3000).optional()
  })
  .strict()
  .refine((request) => (request.action === 'reply') === (request.value !== undefined), {
    message: 'A reply names exactly one of the question’s options; Not needed names none.'
  })

/** The options the hub's prepared action carries for one question; null when any is malformed. */
export function readHandoffQuestionOptions(raw: unknown): HandoffQuestionOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > OPTIONS_MAX) {
    return null
  }
  const options: HandoffQuestionOption[] = []
  for (const entry of raw) {
    const { label, value } = (entry ?? {}) as { label?: unknown; value?: unknown }
    if (
      typeof label !== 'string' ||
      typeof value !== 'string' ||
      !label.trim() ||
      !value ||
      label.length > OPTION_TEXT_MAX ||
      value.length > OPTION_TEXT_MAX
    ) {
      return null
    }
    options.push({ label, value })
  }
  return options
}
