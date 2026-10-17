import type { z } from 'zod'
import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import {
  captureConsoleWorkflowPerson,
  redactConsoleWorkflowMemory
} from './console-workflow-person'
import { serializeConsoleWorkflowRequest } from './console-workflow-redaction'
import { consoleWorkflowRequestBudget } from './console-workflow-request-budget'
import { routes } from './console-workflow-routes'
import { abandonedOn, failure, record, refusal } from './console-workflow-refusal'

export { failure, refusal, unavailable } from './console-workflow-refusal'

/** Main-only transport: the named client operations choose the route and verb. */
export async function requestConsoleWorkflow<T>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  responseSchema: z.ZodType<T>,
  body?: unknown,
  timeout = 15_000,
  frozenResponse = false,
  expectedPrincipal?: string,
  expectedPersonIsCurrent?: () => boolean,
  /** Why: quit-time callers hold one deadline for capture, auth and fetch alike. */
  signal?: AbortSignal,
  /** Caller-owned request headers; the credential and content headers below always win. */
  extraHeaders?: Record<string, string>
): Promise<ConsoleWorkflowResult<T>> {
  try {
    if (signal?.aborted) {
      return failure('backoffice_unavailable', 'The request was abandoned before it started.')
    }
    if (!routes[method]?.some((route) => route.test.test(path))) {
      return failure('invalid_request', 'This route is not a supported workflow operation.')
    }
    // Why raced: the person capture can refresh a credential over the network, and a
    // quit-time caller's deadline must cover that step too, not only the fetch.
    const captured = signal
      ? await Promise.race([captureConsoleWorkflowPerson(), abandonedOn(signal)])
      : await captureConsoleWorkflowPerson()
    if (!captured.ok) {
      return captured
    }
    const { bearer, baseUrl } = captured.data
    const isCurrent = () => captured.data.isCurrent() && (expectedPersonIsCurrent?.() ?? true)
    if (expectedPrincipal !== undefined && captured.data.principal !== expectedPrincipal) {
      return failure('principal_mismatch', 'Sign in as the person who activated this job.')
    }
    let serialized: string | undefined
    try {
      // Why: the requests that carry a whole file (handoff versions and attachments, an
      // employee transcript) get their own budget; every other body stays small.
      const maxBytes = consoleWorkflowRequestBudget(path)
      serializeConsoleWorkflowRequest(
        { path, ...(body === undefined ? {} : { body }) },
        bearer,
        redactConsoleWorkflowMemory,
        maxBytes
      )
      serialized =
        body === undefined
          ? undefined
          : serializeConsoleWorkflowRequest(body, bearer, redactConsoleWorkflowMemory, maxBytes)
    } catch {
      return failure(
        'invalid_request',
        'The workflow request contains protected data or exceeds its size limit.'
      )
    }
    if (!isCurrent()) {
      return failure(
        'connection_changed',
        'The signed-in person or connection changed; refresh before continuing.'
      )
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      redirect: 'error',
      credentials: 'omit',
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(timeout), signal])
        : AbortSignal.timeout(timeout),
      headers: {
        ...extraHeaders,
        accept: 'application/json',
        Authorization: `Bearer ${bearer}`,
        ...(serialized === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(serialized === undefined ? {} : { body: serialized })
    })
    let raw: unknown
    try {
      raw = await readFetchResponseJsonWithinLimit<unknown>(response, 2_097_152)
    } catch {
      return response.ok
        ? failure('invalid_response', 'The backoffice returned an unreadable workflow response.')
        : refusal({}, response.status)
    }
    if (!isCurrent()) {
      return failure(
        'connection_changed',
        'The signed-in person or connection changed; refresh before continuing.'
      )
    }
    const safe = redactConsoleWorkflowMemory(raw)
    if (!response.ok || record(safe).ok === false) {
      return refusal(safe, response.status)
    }
    if (frozenResponse && JSON.stringify(raw) !== JSON.stringify(safe)) {
      return failure(
        'invalid_response',
        'The reviewed graph contains protected data; request a new preview.'
      )
    }
    const decoded = responseSchema.safeParse(safe)
    return decoded.success
      ? { ok: true, data: decoded.data }
      : failure(
          'invalid_response',
          `The backoffice response does not match this workflow contract (${describeContractIssues(decoded.error)}).`
        )
  } catch {
    // Transport exceptions can contain URLs, response bodies or the live credential.
    return failure(
      'backoffice_unavailable',
      'The backoffice could not be reached. Refresh to check the recorded result.'
    )
  }
}

export function validated<A, T>(
  value: unknown,
  schema: z.ZodType<A>,
  send: (args: A) => Promise<ConsoleWorkflowResult<T>>
): Promise<ConsoleWorkflowResult<T>> {
  try {
    const parsed = schema.safeParse(value)
    return parsed.success
      ? send(parsed.data)
      : Promise.resolve(
          failure('invalid_request', 'The workflow request does not match this operation.')
        )
  } catch {
    return Promise.resolve(failure('invalid_request', 'The workflow request could not be read.'))
  }
}

export type ConsoleWorkflowUploadFile = {
  /** Base name only; the board refuses paths, dotfiles and reserved names itself. */
  name: string
  contentType: string
  bytes: Uint8Array<ArrayBuffer>
}

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/**
 * Multipart sibling of `requestConsoleWorkflow` for board file uploads. It is the
 * same transport — same signed person capture, same allowlist, same
 * redirect/cookie/principal posture — differing only in that the body is a
 * multipart form because artifacts are bytes of any type, not JSON. The file names
 * and the instructions log still go through redaction; the bytes are what the
 * person explicitly asked to deliver and are sent as they are on disk.
 */
export async function requestConsoleWorkflowUpload<T>(
  path: string,
  responseSchema: z.ZodType<T>,
  upload: { files: ConsoleWorkflowUploadFile[]; instructions: string },
  timeout = 120_000,
  expectedPrincipal?: string,
  expectedPersonIsCurrent?: () => boolean
): Promise<ConsoleWorkflowResult<T>> {
  try {
    if (!routes.POST.some((route) => route.test.test(path))) {
      return failure('invalid_request', 'This route is not a supported workflow operation.')
    }
    if (upload.files.length === 0) {
      return failure('invalid_request', 'A file upload needs at least one file.')
    }
    const total = upload.files.reduce((sum, file) => sum + file.bytes.byteLength, 0)
    if (total > MAX_UPLOAD_BYTES) {
      return failure('invalid_request', 'The delivery exceeds the upload size limit.')
    }
    const captured = await captureConsoleWorkflowPerson()
    if (!captured.ok) {
      return captured
    }
    const { bearer, baseUrl } = captured.data
    const isCurrent = () => captured.data.isCurrent() && (expectedPersonIsCurrent?.() ?? true)
    if (expectedPrincipal !== undefined && captured.data.principal !== expectedPrincipal) {
      return failure(
        'principal_mismatch',
        'The signed-in person changed before uploading task inputs.'
      )
    }
    try {
      serializeConsoleWorkflowRequest(
        { path, names: upload.files.map((file) => file.name), instructions: upload.instructions },
        bearer,
        redactConsoleWorkflowMemory
      )
    } catch {
      return failure(
        'invalid_request',
        'The workflow request contains protected data or exceeds its size limit.'
      )
    }
    const form = new FormData()
    for (const file of upload.files) {
      form.append('files', new Blob([file.bytes], { type: file.contentType }), file.name)
    }
    form.append('instructions', upload.instructions)
    if (!isCurrent()) {
      return failure(
        'connection_changed',
        'The signed-in person or connection changed; refresh before continuing.'
      )
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeout),
      headers: { accept: 'application/json', Authorization: `Bearer ${bearer}` },
      body: form
    })
    let raw: unknown
    try {
      raw = await readFetchResponseJsonWithinLimit<unknown>(response, 2_097_152)
    } catch {
      return response.ok
        ? failure('invalid_response', 'The backoffice returned an unreadable upload response.')
        : refusal({}, response.status)
    }
    if (!isCurrent()) {
      return failure(
        'connection_changed',
        'The signed-in person or connection changed; refresh before continuing.'
      )
    }
    const safe = redactConsoleWorkflowMemory(raw)
    if (!response.ok || record(safe).ok === false) {
      return refusal(safe, response.status)
    }
    const decoded = responseSchema.safeParse(safe)
    return decoded.success
      ? { ok: true, data: decoded.data }
      : failure('invalid_response', 'The backoffice response does not match this upload contract.')
  } catch {
    return failure(
      'backoffice_unavailable',
      'The backoffice could not be reached. Refresh to check the recorded result.'
    )
  }
}

/**
 * Why: a contract mismatch that names no field is undebuggable — the Jobs view showed only
 * "does not match this workflow contract" against the live console. Name the paths and the
 * schema's own message, never the response values (the payload is already redacted).
 */
export function describeContractIssues(error: z.ZodError): string {
  const shown = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'response'
    return `${path}: ${issue.message}`
  })
  const rest = error.issues.length - shown.length
  return `${shown.join('; ')}${rest > 0 ? `; +${rest} more` : ''}`
}
