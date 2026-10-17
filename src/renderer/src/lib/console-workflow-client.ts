import type {
  ConsoleWorkflowApi,
  ConsoleWorkflowError
} from '../../../shared/console-workflow-types'
import { translate } from '@/i18n/i18n'

export type WorkflowData<Operation extends keyof ConsoleWorkflowApi> = Extract<
  Awaited<ReturnType<NonNullable<ConsoleWorkflowApi[Operation]>>>,
  { ok: true }
>['data']

export class WorkflowRequestError extends Error {
  constructor(readonly detail: ConsoleWorkflowError) {
    super(detail.message)
    this.name = 'WorkflowRequestError'
  }
}

export function consoleWorkflowApi(): ConsoleWorkflowApi {
  const api = window.api?.consoleWorkflows
  if (!api) {
    throw new WorkflowRequestError({
      code: 'capability_unavailable',
      message: translate(
        'consoleWorkflows.apiUnavailable',
        'The workflow API is unavailable in this version of OmniConsole.'
      )
    })
  }
  return api
}

export function workflowData<T>(
  result: { ok: true; data: T } | { ok: false; error: ConsoleWorkflowError }
): T {
  if (!result.ok) {
    throw new WorkflowRequestError(result.error)
  }
  return result.data
}

export function workflowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isStaleWorkflowResponse(error: unknown): boolean {
  return (
    error instanceof WorkflowRequestError &&
    (error.detail.status === 409 || /stale|revision_conflict/.test(error.detail.code))
  )
}

export function workflowWebLink(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export function downloadWorkflowExport(
  content: string,
  format: 'json' | 'mermaid' | 'text',
  /** File name for surfaces that export something other than a server workflow. */
  fileName?: string
): void {
  const url = URL.createObjectURL(
    new Blob([content], { type: format === 'json' ? 'application/json' : 'text/plain' })
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download =
    fileName ?? `workflow.${format === 'json' ? 'json' : format === 'text' ? 'txt' : 'mmd'}`
  anchor.click()
  URL.revokeObjectURL(url)
}
