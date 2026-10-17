import { open } from 'node:fs/promises'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { isNativePeerInboxBinding } from '../../shared/native-peer-inbox-binding'

export const TERMINAL_PEER_INBOX_HANDLERS: Record<string, CommandHandler> = {
  'terminal peer-inbox-bind': async ({ flags, client }) => {
    const path = getRequiredStringFlag(flags, 'binding-file')
    const file = await open(path, 'r')
    let binding: unknown
    try {
      const buffer = Buffer.alloc(16_385)
      const { bytesRead } = await file.read(buffer)
      if (bytesRead > 16_384) {
        throw new Error('binding too large')
      }
      binding = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
      if (!isNativePeerInboxBinding(binding)) {
        throw new Error('invalid binding')
      }
    } catch {
      throw new RuntimeClientError('invalid_argument', 'Invalid native peer binding file')
    } finally {
      await file.close()
    }
    const result = await client.call('terminal.peerInboxBind', { binding })
    printResult(result, true, (value) => JSON.stringify(value))
  },
  'terminal peer-inbox-status': async ({ flags, client }) => {
    const result = await client.call('terminal.peerInboxStatus', {
      terminal: getRequiredStringFlag(flags, 'terminal')
    })
    printResult(result, true, (value) => JSON.stringify(value))
  },
  'terminal peer-inbox-complete': async ({ flags, client }) => {
    const result = await client.call('terminal.peerInboxComplete', {
      terminal: getRequiredStringFlag(flags, 'terminal'),
      bindingKey: getRequiredStringFlag(flags, 'binding-key'),
      nonce: getRequiredStringFlag(flags, 'nonce')
    })
    printResult(result, true, (value) => JSON.stringify(value))
  },
  'terminal peer-inbox-stop': async ({ flags, client }) => {
    const result = await client.call('terminal.peerInboxStop', {
      terminal: getRequiredStringFlag(flags, 'terminal')
    })
    printResult(result, true, (value) => JSON.stringify(value))
  }
}
