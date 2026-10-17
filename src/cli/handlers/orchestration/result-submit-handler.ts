import { readFile } from 'node:fs/promises'
import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import {
  resolveOrchestrationTerminalHandle,
  throwNoActiveSenderTerminal
} from './terminal-identity'

const MAX_RESULT_BYTES = 256 * 1024

export const ORCHESTRATION_RESULT_SUBMIT_HANDLER: Record<string, CommandHandler> = {
  'orchestration result-submit': async ({ flags, client, cwd, json }) => {
    if (!getOptionalStringFlag(flags, 'from') && !process.env.ORCA_TERMINAL_HANDLE) {
      throwNoActiveSenderTerminal()
    }
    const file = getRequiredStringFlag(flags, 'file')
    const bytes = await readFile(file)
    if (bytes.length > MAX_RESULT_BYTES) {
      throw new RuntimeClientError('invalid_argument', 'Workflow result exceeds 256 KiB.')
    }
    let result: unknown
    try {
      result = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new RuntimeClientError('invalid_argument', 'Workflow result file is not valid JSON.')
    }
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from', {
      validateEnvHandle: true,
      allowActiveFallback: false
    })
    const dispatch = getRequiredStringFlag(flags, 'dispatch')
    const capability = getRequiredStringFlag(flags, 'dispatch-capability')
    const response = await client.call<{
      accepted: boolean
      duplicate?: boolean
      problems?: string
    }>(
      'orchestration.resultSubmit',
      { dispatch, from, result },
      { orchestrationCapability: capability }
    )
    if (!response.result.accepted) {
      throw new RuntimeClientError(
        'structured_result_invalid',
        response.result.problems ?? 'The workflow result did not satisfy its schema.'
      )
    }
    printResult(response, json, (value) =>
      value.duplicate ? 'Workflow result already accepted.' : 'Workflow result accepted.'
    )
  }
}
