import { translate } from '@/i18n/i18n'
import type { RoomErrorCode } from '../../../../shared/rooms'

export function roomErrorText(code: RoomErrorCode): string {
  switch (code) {
    case 'device_unauthorized':
      return translate(
        'rooms.error.account',
        'The account link expired or was revoked. Link your account again.'
      )
    case 'forbidden':
      return translate('rooms.error.forbidden', 'This account cannot access that room action.')
    case 'not_ready':
      return translate('rooms.error.notReady', 'Online Rooms is not ready on this console.')
    case 'config_missing':
      return translate(
        'rooms.error.config',
        'The console has not supplied room service addresses. Set the fallback addresses below.'
      )
    case 'console_unavailable':
      return translate(
        'rooms.error.console',
        'Sign in to OmniConsole and check the console connection in Settings.'
      )
    case 'secure_storage_unavailable':
      return translate(
        'rooms.error.storageUnavailable',
        'Secure account storage is unavailable on this computer.'
      )
    case 'storage_error':
      return translate(
        'rooms.error.storage',
        'The account link could not be saved or read securely.'
      )
    case 'invalid_callback':
    case 'link_expired':
      return translate(
        'rooms.error.callback',
        'The browser link was invalid or expired. Start linking again.'
      )
    case 'connection_changed':
      return translate(
        'rooms.error.changed',
        'The account or connection changed. Refresh Online Rooms.'
      )
    case 'idempotency_conflict':
    case 'conflict':
      return translate(
        'rooms.error.conflict',
        'This message conflicts with the recorded request. Refresh the room before sending again.'
      )
    case 'invalid_request':
      return translate('rooms.error.request', 'Check the message, mentions, and service addresses.')
    case 'timeout':
    case 'network_error':
      return translate(
        'rooms.error.network',
        'The room service could not be reached. A send may have completed; retrying the unchanged draft uses the same message ID.'
      )
    case 'rate_limited':
      return translate('rooms.error.rate', 'Too many room requests. Wait before trying again.')
    case 'room_full':
      return translate('rooms.error.full', 'This room has no seats left.')
    case 'host_membership':
      return translate(
        'rooms.error.membership',
        'You are not an admitted member of this room. Ask the host for an invitation.'
      )
    case 'not_found':
      return translate('rooms.error.notFound', 'That room or message no longer exists.')
    case 'rooms_unavailable':
      return translate(
        'rooms.error.roomsUnavailable',
        'Online Rooms are unavailable right now. Try again later.'
      )
    case 'invalid_response':
    case 'response_too_large':
      return translate(
        'rooms.error.unavailable',
        'The room response could not be verified. Refresh to try again.'
      )
  }
}
