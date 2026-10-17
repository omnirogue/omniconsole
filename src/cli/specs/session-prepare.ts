import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const SESSION_PREPARE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'prepare'],
    summary: 'Submit a signed AI operator connector request to session prep on this computer',
    usage: 'omni session prepare --connector-file <request.json> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'connector-file'],
    examples: ['omni session prepare --connector-file request.json --json'],
    notes: [
      'Connector transport only: the host requires and verifies the signed AI operator request. A local CLI or agent cannot grant itself permission to prepare a session.',
      'The file is forwarded unchanged as a JSON object. Repeating a durable request returns its current batch state. Refusal or timeout never falls back to an unprepared launch.'
    ]
  }
]
