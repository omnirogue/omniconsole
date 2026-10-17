import {
  FetchResponseBodyTooLargeError,
  readFetchResponseTextWithinLimit
} from '../../shared/fetch-response-body'
import { RoomError, responseErrorCode } from './room-error'

/** Shared by device exchange and room reads; callers cannot supply transport headers. */
export async function roomRequest(
  fetcher: typeof fetch,
  url: string,
  options: {
    token?: string
    body?: unknown
    idempotencyKey?: string
    allowEmpty?: boolean
  } = {}
): Promise<unknown> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new RoomError('timeout'))
    }, 15000)
  })
  const operation = async () => {
    const response = await fetcher(url, {
      method: options.body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    })
    if (
      controller.signal.aborted ||
      response.redirected ||
      (response.url && response.url !== url)
    ) {
      void response.body?.cancel().catch(() => undefined)
      throw new RoomError('invalid_response')
    }
    if (response.status === 204 && options.allowEmpty) {
      return null
    }
    const text = await readFetchResponseTextWithinLimit(response, 2 * 1024 * 1024)
    if (options.token && text.includes(options.token)) {
      throw new RoomError('invalid_response')
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      value = null
    }
    if (!response.ok) {
      throw new RoomError(responseErrorCode(response.status, value))
    }
    if (
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
      value === null
    ) {
      throw new RoomError('invalid_response')
    }
    return value
  }
  try {
    return await Promise.race([operation(), timeout])
  } catch (error) {
    if (error instanceof RoomError) {
      throw error
    }
    throw new RoomError(
      error instanceof FetchResponseBodyTooLargeError ? 'response_too_large' : 'network_error'
    )
  } finally {
    clearTimeout(timer)
  }
}
