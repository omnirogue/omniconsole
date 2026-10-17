import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_PEER_INBOX_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['terminal', 'peer-inbox-bind'],
    summary: 'Bind an enrolled task to its exact existing native Codex session',
    usage: 'omni terminal peer-inbox-bind --binding-file <path>',
    allowedFlags: [...GLOBAL_FLAGS, 'binding-file']
  },
  {
    path: ['terminal', 'peer-inbox-status'],
    summary: 'Inspect native inbox hint state without consuming hub messages',
    usage: 'omni terminal peer-inbox-status --terminal <exact handle>',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal']
  },
  {
    path: ['terminal', 'peer-inbox-complete'],
    summary: 'Settle a native hint after the model finishes its canonical inbox pass',
    usage:
      'omni terminal peer-inbox-complete --terminal <exact handle> --binding-key <key> --nonce <nonce>',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'binding-key', 'nonce'],
    notes: [
      'This records native hint completion only; it never acknowledges or resolves hub messages.'
    ]
  },
  {
    path: ['terminal', 'peer-inbox-stop'],
    summary: 'Stop one exact native inbox receiver without changing enrollment',
    usage: 'omni terminal peer-inbox-stop --terminal <exact handle>',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal']
  }
]
