import { ZodError } from 'zod'
import { ROOM_ERROR_CODES, type RoomErrorCode, type RoomResult } from '../../shared/rooms'

export class RoomError extends Error {
  constructor(readonly code: RoomErrorCode) {
    super(code)
  }
}
export function roomErrorCode(error: unknown): RoomErrorCode {
  return error instanceof RoomError
    ? error.code
    : error instanceof ZodError
      ? 'invalid_request'
      : 'network_error'
}
export async function roomResult<T>(operation: () => Promise<T>): Promise<RoomResult<T>> {
  try {
    return { ok: true, data: await operation() }
  } catch (error) {
    return { ok: false, error: { code: roomErrorCode(error) } }
  }
}
export function responseErrorCode(status: number, value: unknown): RoomErrorCode {
  if (status === 401) {
    return 'device_unauthorized'
  }
  if (status === 403) {
    return 'forbidden'
  }
  if (status === 409) {
    const code = value && typeof value === 'object' && 'error' in value ? value.error : null
    return ROOM_ERROR_CODES.find((allowed) => allowed === code) ?? 'conflict'
  }
  return status === 404
    ? 'not_found'
    : status === 429
      ? 'rate_limited'
      : status >= 500
        ? 'rooms_unavailable'
        : 'invalid_request'
}
