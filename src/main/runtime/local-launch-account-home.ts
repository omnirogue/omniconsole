/**
 * The account home a launch would run under right now, from the canonical freshen and chooser (an
 * unfocused, headless host refreshes stale rows first; the Fable rule and the selected default
 * apply); a refusal names why no account is verified. Never pinned and never fenced: the launch
 * that follows chooses again.
 */

import type { CapacityProvider } from '../../shared/provider-account-capacity'
import { launchRefusalText } from '../../shared/account-launch-verdict'
import { localHostLabel } from '../local-host-label'
import {
  chooseLocalLaunchAccount,
  NO_ACCOUNT_SERVICES_REFUSAL,
  type LaunchAccountCapacity
} from './agent-session-local-account'

export async function chooseLocalLaunchHome(
  capacity: LaunchAccountCapacity | null,
  provider: CapacityProvider,
  model: string | undefined
): Promise<{ providerRoot: string; email: string | null } | { refusal: string }> {
  if (!capacity) {
    return { refusal: NO_ACCOUNT_SERVICES_REFUSAL }
  }
  const { choice } = await chooseLocalLaunchAccount(capacity, provider, model)
  const pick = choice.pick
  if (!pick) {
    return { refusal: launchRefusalText(provider, localHostLabel(), choice.verdicts) }
  }
  const home = pick.row.launchEnv?.[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']
  return home?.trim()
    ? { providerRoot: home, email: pick.row.email ?? null }
    : { refusal: `The chosen ${provider} account has no launch home on this computer.` }
}
