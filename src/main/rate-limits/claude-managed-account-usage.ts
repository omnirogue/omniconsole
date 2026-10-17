import { hasClaudeSeatForManagedPath } from './claude-seat-directory'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { refreshClaudeAccountSessionIfIdle } from '../claude-accounts/account-session-refresh'
import {
  isOauthTokenExpiring,
  refreshClaudeOauthCredentials
} from '../claude-accounts/oauth-refresh'
import {
  readClaudeManagedCredentialsJson,
  resolveClaudeManagedCredentialsLocation,
  writeClaudeManagedCredentialsJson,
  type InactiveClaudeAccount
} from './claude-managed-account-credentials'
import { fetchClaudeManagedUsagePanelSupplement } from './claude-managed-usage-panel'
import { parseClaudeOAuthCredentialsJson } from './claude-oauth-credentials'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import { makeClaudeUsageClassificationError } from './claude-oauth-recovery'
import { classifyClaudeOAuthUsageError } from './claude-usage-error-classification'
import type { ClaudeManagedAccountUsageOptions } from './claude-usage-fetch-options'
import {
  abortedClaudeRateLimitResult,
  canSupplementClaudeOAuthUsage,
  mergeClaudeUsageWindows,
  warnClaudeUsageFetchFailure
} from './claude-usage-result'

function noClaudeManagedCredentialsResult(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'No credentials',
    usageMetadata: { failureKind: 'missing-credentials' },
    status: 'error'
  }
}

export async function fetchInactiveClaudeAccountUsage(
  account: InactiveClaudeAccount,
  options: ClaudeManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  const location = resolveClaudeManagedCredentialsLocation(account)
  const sessionCredentials = location
    ? await refreshClaudeAccountSessionIfIdle(
        account.id,
        location.managedAuthPath,
        account.lastAuthenticatedAt
      )
    : null
  let credentialsJson =
    sessionCredentials ?? (location ? await readClaudeManagedCredentialsJson(location) : null)
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (!location || !credentialsJson) {
    return noClaudeManagedCredentialsResult()
  }

  let token = parseClaudeOAuthCredentialsJson(credentialsJson, 'credentials-file').token
  if (
    !sessionCredentials &&
    (account.managedAuthRuntime === 'wsl' ||
      !hasClaudeSeatForManagedPath(location.managedAuthPath)) &&
    isOauthTokenExpiring(credentialsJson)
  ) {
    const refreshed = await refreshClaudeOauthCredentials(credentialsJson)
    if (options.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    if (refreshed) {
      try {
        await writeClaudeManagedCredentialsJson(location, refreshed)
      } catch {
        // Keep the refreshed token for this fetch; a later poll can persist it.
      }
      credentialsJson = refreshed
      token = parseClaudeOAuthCredentialsJson(refreshed, 'credentials-file').token
    }
  }

  if (!token) {
    return noClaudeManagedCredentialsResult()
  }
  let oauthLimits: ProviderRateLimits
  try {
    oauthLimits = await fetchClaudeOAuthUsage(token, options.signal)
  } catch (error) {
    if (options.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    const result = makeClaudeUsageClassificationError({
      error,
      classification: classifyClaudeOAuthUsageError(error),
      attempts: { attemptedSources: ['oauth'] },
      oauthCredentials: parseClaudeOAuthCredentialsJson(credentialsJson, 'credentials-file')
    })
    return {
      ...result,
      usageMetadata: { ...result.usageMetadata, authProvenance: `managed:${account.id}` }
    }
  }
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (
    !canSupplementClaudeOAuthUsage({
      oauthLimits,
      authPreparation: undefined,
      allowUsagePanelSupplement: options.allowUsagePanelSupplement === true
    })
  ) {
    return oauthLimits
  }

  try {
    return mergeClaudeUsageWindows(
      oauthLimits,
      await fetchClaudeManagedUsagePanelSupplement({
        account,
        location,
        credentialsJson,
        oauthLimits,
        networkProxySettings: options.networkProxySettings,
        signal: options.signal
      })
    )
  } catch (error) {
    warnClaudeUsageFetchFailure(
      undefined,
      parseClaudeOAuthCredentialsJson(credentialsJson, 'credentials-file'),
      error
    )
    return oauthLimits
  }
}
