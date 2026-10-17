import { SESSION_PREP_RPC } from '../../shared/session-prep-types'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { readTextInputFile } from '../text-input-file'
import { refuseRemote } from './session-manage-access'

export const SESSION_PREPARE_HANDLERS: Record<string, CommandHandler> = {
  'session prepare': async ({ client, flags, cwd, json }) => {
    refuseRemote(client)
    const text = await readTextInputFile(getRequiredStringFlag(flags, 'connector-file'), cwd, {
      label: 'signed connector request',
      maxBytes: 256 * 1024
    })
    let request: unknown
    try {
      request = JSON.parse(text)
    } catch {
      throw new RuntimeClientError(
        'invalid_argument',
        '--connector-file must hold one JSON object.'
      )
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--connector-file must hold one JSON object.'
      )
    }
    // The host verifies the signed operator and exact request; the transport grants no authority.
    const response = await client.call(SESSION_PREP_RPC.request, request, { timeoutMs: 45_000 })
    printResult(response, json, (value) => JSON.stringify(value, null, 2))
  }
}
