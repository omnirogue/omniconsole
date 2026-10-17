import type { AutomationLaunchPreferences } from '../../shared/automations-types'
import type { CodexRateLimitAccountsState } from '../../shared/managed-account-types'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

export async function getAutomationLaunchFlags(
  flags: Map<string, string | boolean>,
  client: Parameters<CommandHandler>[0]['client']
): Promise<AutomationLaunchPreferences | null | undefined> {
  const model = getOptionalStringFlag(flags, 'model')
  const effort = getOptionalStringFlag(flags, 'effort')
  const account = getOptionalStringFlag(flags, 'codex-account')
  if (flags.has('clear-launch-preferences')) {
    if (flags.get('clear-launch-preferences') !== true || model || effort || account) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--clear-launch-preferences takes no value and cannot be combined with launch preferences'
      )
    }
    return null
  }
  if (!model && !effort && !account) {
    return undefined
  }
  let codexAccountId: string | undefined
  if (account) {
    const snapshot = await client.call<{ codex: CodexRateLimitAccountsState }>('accounts.list', {
      refreshUsage: false
    })
    const matches = snapshot.result.codex.accounts.filter(
      (entry) => entry.id === account || entry.email.toLowerCase() === account.toLowerCase()
    )
    if (matches.length !== 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Codex account must identify exactly one managed account; use its ID for duplicate emails'
      )
    }
    codexAccountId = matches[0].id
  }
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(codexAccountId ? { codexAccountId } : {})
  }
}
