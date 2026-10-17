import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../../core'
import {
  isNativePeerInboxBinding,
  type NativePeerInboxBinding
} from '../../../../../shared/native-peer-inbox-binding'
import { getNativePeerInboxOwner } from '../../../native-peer-inbox-owner'

const ExactTerminal = z.object({ terminal: z.string().min(1).max(512) }).strict()

export const TERMINAL_PEER_INBOX_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.peerInboxBind',
    params: z
      .object({ binding: z.custom<NativePeerInboxBinding>(isNativePeerInboxBinding) })
      .strict(),
    handler: async ({ binding }, { runtime }) => ({
      receiver: await getNativePeerInboxOwner(runtime).bind(binding)
    })
  }),
  defineMethod({
    name: 'terminal.peerInboxStatus',
    params: ExactTerminal,
    handler: ({ terminal }, { runtime }) => ({
      receiver: getNativePeerInboxOwner(runtime).status(terminal)
    })
  }),
  defineMethod({
    name: 'terminal.peerInboxComplete',
    params: ExactTerminal.extend({
      bindingKey: z.string().regex(/^[a-f0-9]{64}$/),
      nonce: z.string().uuid()
    }),
    handler: async ({ terminal, bindingKey, nonce }, { runtime }) => ({
      receiver: await getNativePeerInboxOwner(runtime).complete(terminal, bindingKey, nonce)
    })
  }),
  defineMethod({
    name: 'terminal.peerInboxStop',
    params: ExactTerminal,
    handler: ({ terminal }, { runtime }) => {
      getNativePeerInboxOwner(runtime).stop(terminal)
      return { stopped: true }
    }
  })
]
