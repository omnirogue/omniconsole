import type { NextStepProblem } from '../../../../shared/next-step-draft'

export type NextStepSendResult =
  | { ok: true; message: string }
  | { ok: false; message: string; problems?: NextStepProblem[] }

export function newOperationId(): string {
  return `ns_${crypto.randomUUID().replace(/-/g, '')}`
}

export function refused(message: string, problems?: NextStepProblem[]): NextStepSendResult {
  return { ok: false, message, ...(problems ? { problems } : {}) }
}

export function sent(message: string): NextStepSendResult {
  return { ok: true, message }
}
