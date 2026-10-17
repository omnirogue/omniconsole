import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { discoverExistingAccountDirectories } from '../main/rate-limits/existing-account-directories'
import { probeSelectedAccountUsage } from '../main/rate-limits/selected-account-usage'
import { claudeConfigDirEnvPatch } from '../main/claude/claude-config-dir-pin'
import type { ProviderRateLimits } from '../shared/rate-limit-types'
import {
  SESSION_PREP_ACCOUNT_METHOD,
  sessionPrepAccountRequest,
  type SessionPrepAccount
} from '../shared/session-prep-account'
import type { RelayDispatcher } from './dispatcher'
import { listPoolOAuthTokenFiles, readPoolOAuthToken } from './pool-oauth-token-file'

type Candidate = Omit<SessionPrepAccount, 'ageAtReplyMs' | 'processingMs'>

/** Reads only this SSH user's profiles and live usage; credentials never cross the relay. */
export function registerSessionPrepAccountHandler(dispatcher: RelayDispatcher): void {
  dispatcher.onRequest(SESSION_PREP_ACCOUNT_METHOD, async (raw) => {
    const startedAt = performance.now()
    const request = sessionPrepAccountRequest.parse(raw)
    const home = homedir()
    const profiles = discoverExistingAccountDirectories(home).filter(
      (profile) => profile.provider === request.provider && profile.runtime !== 'wsl'
    )
    // Why pool slots: fleet Macs run their work on the estate's setup-token pool, and most have at
    // most one desktop login, so the pool is where their verified capacity actually is.
    const tokenFiles = request.provider === 'claude' ? await listPoolOAuthTokenFiles(home) : []
    if (profiles.length + tokenFiles.length > 64) {
      throw new Error('Too many account profiles to verify for this launch.')
    }
    const jobs: (() => Promise<Candidate | null>)[] = [
      ...profiles.map((profile) => async () => {
        // Setup-token-only profiles cannot launch with a config directory alone.
        await access(
          join(profile.path, request.provider === 'claude' ? '.credentials.json' : 'auth.json')
        )
        const usage = await probeSelectedAccountUsage(
          { version: 1, provider: request.provider, configRoot: profile.path },
          { claudeLoginOnly: true }
        )
        const verified = verifiedHeadroom(usage, request.model)
        return verified
          ? {
              provider: request.provider,
              pinConfigDir:
                request.provider !== 'claude' ||
                Boolean(claudeConfigDirEnvPatch(profile.path, { env: {} }).CLAUDE_CONFIG_DIR),
              configRoot: profile.path,
              ...verified
            }
          : null
      }),
      ...tokenFiles.map((file) => async () => {
        const configRoot = dirname(file)
        const token = await readPoolOAuthToken(file, home)
        const usage = await probeSelectedAccountUsage({
          version: 1,
          provider: 'claude',
          configRoot,
          token
        })
        const verified = verifiedHeadroom(usage, request.model)
        return verified
          ? {
              provider: 'claude' as const,
              pinConfigDir: false,
              configRoot,
              oauthTokenFile: file,
              ...verified
            }
          : null
      })
    ]
    const candidates: Candidate[] = []
    // Bounded batches avoid a request storm and preserve unknowns as unavailable.
    for (let offset = 0; offset < jobs.length; offset += 4) {
      const settled = await Promise.all(
        jobs.slice(offset, offset + 4).map((job) =>
          // Missing, signed-out and unverifiable profiles are not spare capacity.
          job().catch(() => null)
        )
      )
      candidates.push(...settled.filter((row): row is Candidate => row !== null))
    }
    const now = Date.now()
    const fresh = candidates.filter((row) => now >= row.readingAt && now - row.readingAt <= 60_000)
    fresh.sort(
      (a, b) => b.remainingPercent - a.remainingPercent || a.configRoot.localeCompare(b.configRoot)
    )
    if (!fresh[0]) {
      throw new Error(
        `No ${request.provider} account with fresh verified capacity on this SSH host.`
      )
    }
    return {
      ...fresh[0],
      ageAtReplyMs: now - fresh[0].readingAt,
      processingMs: performance.now() - startedAt
    }
  })
}

/**
 * The tightest known window's headroom from a live reading. Unknown windows are skipped, not
 * refused: null only for a failed reading, no known window, a Fable model without its Fable
 * window, or no room left.
 */
function verifiedHeadroom(
  usage: ProviderRateLimits,
  model: string | undefined
): { readingAt: number; remainingPercent: number } | null {
  const windows = [usage.session, usage.weekly]
  if (model?.toLowerCase().includes('fable')) {
    if (!usage.fableWeekly) {
      return null
    }
    windows.push(usage.fableWeekly)
  }
  const known = windows.filter((window) => window !== null)
  if (usage.status !== 'ok' || known.length === 0) {
    return null
  }
  const remainingPercent = Math.min(...known.map((window) => 100 - window.usedPercent))
  if (!Number.isFinite(remainingPercent) || remainingPercent <= 0 || remainingPercent > 100) {
    return null
  }
  return { readingAt: usage.updatedAt, remainingPercent }
}
