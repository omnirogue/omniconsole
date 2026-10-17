export type CodexRateLimitFetchOptions = {
  codexHomePath?: string | null
  requireUnexpiredAccessToken?: boolean
  allowPtyFallback?: boolean
  signal?: AbortSignal
}
