import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { consoleTaskSetup } from '../../shared/console-task-setup'

export function failure<T>(
  code: string,
  message: string,
  status?: number
): ConsoleWorkflowResult<T> {
  return { ok: false, error: { code, message, ...(status === undefined ? {} : { status }) } }
}
export function unavailable<T>(operation: string): Promise<ConsoleWorkflowResult<T>> {
  return Promise.resolve(
    failure('capability_unavailable', `The backoffice contract does not yet provide ${operation}.`)
  )
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
export function refusal<T>(payload: unknown, status: number): ConsoleWorkflowResult<T> {
  const root = record(payload)
  const error = record(root.error)
  const detail = record(root.detail)
  // Why: the console's own read table refuses with `{detail, tag}`; the tag names what it refused.
  const suppliedCode = error.code ?? detail.code ?? root.code ?? root.tag
  const code =
    typeof suppliedCode === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(suppliedCode)
      ? suppliedCode
      : status === 401
        ? 'signed_in_required'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'capability_unavailable'
            : 'backoffice_refused'
  const suppliedMessage =
    error.message ??
    detail.message ??
    root.message ??
    root.reason ??
    (typeof root.detail === 'string' ? root.detail : undefined) ??
    (Array.isArray(root.detail)
      ? root.detail
          .map((entry) => {
            const issue = record(entry)
            const location = Array.isArray(issue.loc) ? issue.loc.join('.') : ''
            return typeof issue.msg === 'string'
              ? `${location ? `${location}: ` : ''}${issue.msg}`
              : ''
          })
          .filter(Boolean)
          .join('; ') || undefined
      : undefined) ??
    root.error
  const message =
    typeof suppliedMessage === 'string'
      ? suppliedMessage.slice(0, 1500)
      : `The backoffice refused this request (HTTP ${status}).`
  // Why: a refusal can carry facts the caller recovers from — the hub's 409
  // stale_snapshot names the stored seq. Objects only, never prose.
  const suppliedDetails = error.details ?? detail.details ?? root.details
  const details =
    suppliedDetails && typeof suppliedDetails === 'object' && !Array.isArray(suppliedDetails)
      ? (suppliedDetails as Record<string, unknown>)
      : undefined
  const setup =
    code === 'task_setup_required'
      ? consoleTaskSetup.safeParse(
          Object.keys(error).length ? error : Object.keys(detail).length ? detail : root
        )
      : undefined
  return {
    ok: false,
    error: {
      code,
      message,
      status,
      ...(details ? { details } : {}),
      ...(setup?.success ? { taskSetup: setup.data } : {})
    }
  }
}

export function abandonedOn(signal: AbortSignal): Promise<ConsoleWorkflowResult<never>> {
  return new Promise((resolve) => {
    signal.addEventListener(
      'abort',
      () =>
        resolve(failure('backoffice_unavailable', 'The request was abandoned at its deadline.')),
      { once: true }
    )
  })
}
