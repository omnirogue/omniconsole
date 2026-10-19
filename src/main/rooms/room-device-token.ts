import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { RoomError } from './room-error'
import { roomRequest } from './room-request'

export const ROOM_CALLBACK = 'omniconsole-ide://account-link/callback'
const SCOPE = 'account:read credits:read credits:spend rooms:read rooms:write'
export const tokenResponse = z.object({
  access_token: z.string().regex(/^or_obp_[A-Za-z0-9_-]{43}$/),
  refresh_token: z
    .string()
    .regex(/^or_obr_[A-Za-z0-9_-]{43}$/)
    .optional(),
  token_type: z.literal('Bearer'),
  scope: z
    .string()
    .refine((value) => value.split(' ').sort().join(' ') === SCOPE.split(' ').sort().join(' ')),
  expires_in: z.number().int().min(1).max(3600)
})
export const storedCredential = z.object({
  token: tokenResponse.shape.access_token,
  refreshToken: tokenResponse.shape.refresh_token,
  expiresAt: z.number(),
  binding: z.string()
})

export function authorizationCode(raw: string, expectedState: string): string {
  const invalid = () => new RoomError('invalid_callback')
  if (raw.length > 2048 || !raw.startsWith(`${ROOM_CALLBACK}?`) || /[\s#]/.test(raw)) {
    throw invalid()
  }
  const url = new URL(raw),
    keys = [...url.searchParams.keys()],
    state = url.searchParams.get('state')
  if (
    `${url.protocol}//${url.host}${url.pathname}` !== ROOM_CALLBACK ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !state ||
    !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    state.length !== expectedState.length ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))
  ) {
    throw invalid()
  }
  const code = url.searchParams.get('code')
  if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code)) {
    throw invalid()
  }
  return code
}

export async function revokeDeviceToken(fetcher: typeof fetch, apiOrigin: string, token: string) {
  try {
    const result = await roomRequest(fetcher, `${apiOrigin}/api/omniconsole/device/revoke`, {
      token,
      body: {},
      allowEmpty: true
    })
    if (result !== null) {
      throw new RoomError('invalid_response')
    }
  } catch (error) {
    if (!(error instanceof RoomError && error.code === 'device_unauthorized')) {
      throw error
    }
  }
}

export async function requestDeviceToken(
  fetcher: typeof fetch,
  apiOrigin: string,
  endpoint: 'token' | 'refresh',
  body: unknown
): Promise<z.infer<typeof tokenResponse>> {
  const value = await roomRequest(fetcher, `${apiOrigin}/api/omniconsole/device/${endpoint}`, { body })
  const parsed = tokenResponse.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }
  const issued = tokenResponse.shape.access_token.safeParse(
    value && typeof value === 'object' && 'access_token' in value ? value.access_token : null
  )
  if (issued.success) {
    await revokeDeviceToken(fetcher, apiOrigin, issued.data).catch(() => undefined)
  }
  throw new RoomError('invalid_response')
}

export function roomDeviceClientId(platform: NodeJS.Platform) {
  const clientPlatform =
    platform === 'darwin'
      ? 'macos'
      : platform === 'win32'
        ? 'windows'
        : platform === 'linux'
          ? 'linux'
          : null
  if (!clientPlatform) {
    throw new RoomError('not_ready')
  }
  return `omniconsole-ide-${clientPlatform}`
}
