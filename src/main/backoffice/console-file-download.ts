import {
  exactHandoffFile,
  HANDOFF_FILE_MAX_BYTES,
  type ExactHandoffFile
} from '../../shared/console-handoff-contract'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import {
  readFetchResponseBytesWithinLimit,
  readFetchResponseJsonWithinLimit
} from '../../shared/fetch-response-body'
import { capturedHandoffFile } from '../../shared/exact-handoff-file-read'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import {
  captureConsoleWorkflowPerson,
  redactConsoleWorkflowMemory
} from './console-workflow-person'
import { failure, refusal } from './console-workflow-transport'
import { routes } from './console-workflow-routes'

/** Only typed main-process file operations construct this route. */
export async function downloadVerifiedConsoleFile(
  path: string,
  file: { name: string; available: boolean; size: number; sha256: string },
  expectedPrincipal?: string
): Promise<ConsoleWorkflowResult<ExactHandoffFile>> {
  if (!routes.GET.some((route) => route.test.test(path))) {
    return failure('invalid_request', 'This file route is not supported.')
  }
  if (
    !exactHandoffFile
      .pick({ name: true, size: true, sha256: true })
      .safeParse({ name: file.name, size: file.size, sha256: file.sha256 }).success
  ) {
    return failure('invalid_request', 'The requested file version is invalid.')
  }
  const person = await captureConsoleWorkflowPerson()
  if (!person.ok) {
    return person
  }
  if (
    !person.data.isCurrent() ||
    (expectedPrincipal && person.data.principal !== expectedPrincipal)
  ) {
    return failure('connection_changed', 'Your account changed. Refresh before opening this file.')
  }
  let response: Response | undefined
  try {
    if (!file.available || file.size > HANDOFF_FILE_MAX_BYTES) {
      return failure('file_unavailable', 'This file is unavailable or exceeds 10 MB.')
    }
    response = await fetch(`${person.data.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${person.data.bearer}` },
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(60_000)
    })
    if (!response.ok) {
      if (response.headers.get('content-type')?.includes('application/json')) {
        try {
          const error = await readFetchResponseJsonWithinLimit<unknown>(response, 65_536)
          if (!person.data.isCurrent()) {
            return failure(
              'connection_changed',
              'Your account changed. Refresh before opening this file.'
            )
          }
          return refusal(redactConsoleWorkflowMemory(error), response.status)
        } catch {
          // Keep the HTTP refusal if its body is malformed or too large.
        }
      }
      return failure('file_unavailable', `The server refused this file (HTTP ${response.status}).`)
    }
    const bytes = Buffer.from(
      await readFetchResponseBytesWithinLimit(response, HANDOFF_FILE_MAX_BYTES)
    )
    if (!person.data.isCurrent()) {
      return failure(
        'connection_changed',
        'Your account changed. Refresh before opening this file.'
      )
    }
    const captured = capturedHandoffFile(file.name, bytes)
    if (captured.size !== file.size || captured.sha256 !== file.sha256) {
      return failure('file_changed', 'The received file does not match this exact version.')
    }
    return { ok: true, data: captured }
  } catch {
    return failure('file_unavailable', 'The file could not be downloaded and verified. Try again.')
  } finally {
    if (response) {
      await cancelUnreadResponseBody(response)
    }
  }
}
