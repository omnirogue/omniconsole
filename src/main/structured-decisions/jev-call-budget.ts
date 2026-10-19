import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * A budgeted workflow's root, for the billed JEV ballots its program asks deep inside a step
 * (agent budget controls). Set by the workflow execution service around a budgeted run.
 */
export type JevCallBudget = {
  admitBounded(input: {
    attemptId: string
    stage: string
    callKey: string
    provider: string
    model: string
    maxInputTokens: number
    maxOutputTokens: number
  }): Promise<unknown>
  settle(receipt: {
    attempt_id: string
    outcome: 'ok' | 'failed' | 'unknown'
    input_tokens?: number
    output_tokens?: number
    provider_request_id?: string
    estimate_from_tokens?: boolean
  }): Promise<void>
  unknown(attemptId: string): Promise<void>
}

export const jevCallBudget = new AsyncLocalStorage<JevCallBudget>()

/** A JEV ballot's answer is a score table: a small, fixed output bound. */
export const JEV_MAX_OUTPUT_TOKENS = 2_048
