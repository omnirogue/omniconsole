export type ClaudeCredentialHealth = {
  accessUsable: boolean
  refreshUsable: boolean
  expired: boolean
}

/** Only health facts leave the credential reader. Unknown refresh expiry is not proof of expiry. */
export function claudeCredentialHealth(
  raw: string | null,
  now = Date.now()
): ClaudeCredentialHealth {
  try {
    const oauth = JSON.parse(raw ?? '{}').claudeAiOauth
    const accessUsable =
      Boolean(oauth?.accessToken) && typeof oauth.expiresAt === 'number' && oauth.expiresAt > now
    const refreshUsable =
      Boolean(oauth?.refreshToken) &&
      (typeof oauth.refreshTokenExpiresAt !== 'number' || oauth.refreshTokenExpiresAt > now)
    return { accessUsable, refreshUsable, expired: Boolean(oauth?.accessToken) && !accessUsable }
  } catch {
    return { accessUsable: false, refreshUsable: false, expired: false }
  }
}

export type ClaudeSourceCandidate = ClaudeCredentialHealth & {
  path: string
  kind: 'session' | 'managed' | 'seat' | 'pool'
}

export function orderClaudeWorkingSources(
  candidates: readonly ClaudeSourceCandidate[]
): ClaudeSourceCandidate[] {
  const hasSeat = candidates.some(
    (candidate) => candidate.kind === 'seat' || candidate.kind === 'pool'
  )
  const rank = (candidate: ClaudeSourceCandidate): number => {
    if (hasSeat && (candidate.kind === 'session' || candidate.kind === 'managed')) {
      return 5
    }
    if ((candidate.kind === 'session' || candidate.kind === 'managed') && candidate.accessUsable) {
      return 0
    }
    if (candidate.kind === 'seat' && candidate.accessUsable) {
      return 1
    }
    if (candidate.kind === 'pool' && candidate.accessUsable) {
      return 2
    }
    if (candidate.kind === 'seat' && candidate.refreshUsable) {
      return 3
    }
    if (candidate.kind === 'pool' && candidate.refreshUsable) {
      return 4
    }
    if (!hasSeat && candidate.refreshUsable) {
      return candidate.kind === 'session' ? 3 : 5
    }
    return 5
  }
  return candidates.filter((candidate) => rank(candidate) < 5).sort((a, b) => rank(a) - rank(b))
}

export function canMaterializeClaudeCredential(
  health: ClaudeCredentialHealth,
  hasSameIdentitySeat: boolean
): boolean {
  return health.accessUsable && !hasSameIdentitySeat
}
