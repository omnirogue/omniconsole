import { homedir } from 'node:os'
import { relative } from 'node:path'
import type { AccountCapacityFacts } from '../../shared/provider-account-capacity-builder'
import type { CapacityProvider } from '../../shared/provider-account-capacity'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  rejectClaudeSource,
  isRejectedClaudeSource,
  type ClaudeWorkingSource
} from './claude-working-source'
import { claudeCredentialHealth } from './claude-credential-health'
import { parseClaudeOAuthCredentialsJson } from './claude-oauth-credentials'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import { OAuthUsageError } from './claude-oauth-usage-error'
import type { AccountCapacityReadings } from './account-capacity-readings'
export type CapacityEntry = AccountCapacityFacts & { path: string; sources?: ClaudeWorkingSource[] }
export const emptyReading = (provider: CapacityProvider): ProviderRateLimits => ({
  provider,
  session: null,
  weekly: null,
  updatedAt: 0,
  status: 'unavailable',
  error: null
})
export async function fetchClaudeCapacityEntry(
  entry: CapacityEntry,
  readings: AccountCapacityReadings
): Promise<ProviderRateLimits> {
  let rejected = false
  let probeFailed = false
  for (const source of entry.sources ?? []) {
    const cached = readings.get(JSON.stringify(['claude', source.path]))
    if ((cached?.usageMetadata?.retryAtMs ?? 0) > Date.now()) {
      return cached!
    }
    let raw: string | null = null
    try {
      raw = await source.read()
    } catch {
      probeFailed = true
      continue
    }
    if (isRejectedClaudeSource(source, raw)) {
      continue
    }
    let health = claudeCredentialHealth(raw)
    if (!health.accessUsable && source.refresh) {
      raw = (await source.refresh()) ?? raw
      health = claudeCredentialHealth(raw)
    }
    if (
      (!health.accessUsable && !health.refreshUsable) ||
      (source.kind === 'managed' && !health.accessUsable)
    ) {
      continue
    }
    entry.path = source.path
    entry.launchEnv = { CLAUDE_CONFIG_DIR: source.path }
    entry.sourceLabel =
      source.kind === 'seat' || source.kind === 'pool'
        ? `~/${relative(homedir(), source.path)}`
        : null
    if (!health.accessUsable) {
      return emptyReading('claude')
    }
    const token = raw ? parseClaudeOAuthCredentialsJson(raw, 'credentials-file').token : null
    if (!token) {
      continue
    }
    try {
      return await fetchClaudeOAuthUsage(token)
    } catch (error) {
      if (
        error instanceof OAuthUsageError &&
        error.status === 403 &&
        error.message.includes('user:profile')
      ) {
        return emptyReading('claude')
      }
      if (error instanceof OAuthUsageError && (error.status === 401 || error.status === 403)) {
        rejected = true
        if (raw) {
          rejectClaudeSource(source, raw)
        }
        continue
      }
      if (error instanceof OAuthUsageError && error.status === 429) {
        return {
          ...emptyReading('claude'),
          status: 'error',
          usageMetadata: {
            failureKind: 'rate-limited',
            retryAtMs: Date.now() + (error.retryAfterMs ?? 300_000)
          }
        }
      }
      throw error
    }
  }
  if (probeFailed) {
    return { ...emptyReading('claude'), status: 'error', usageMetadata: { failureKind: 'network' } }
  }
  entry.launchEnv = null
  entry.signedOutReason = rejected ? 'revoked' : 'expired'
  return {
    ...emptyReading('claude'),
    status: 'error',
    usageMetadata: { failureKind: 'stale-token' }
  }
}
