export type ProviderLoginRequest = {
  provider: 'claude' | 'codex'
  accountId?: string
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export type ProviderLoginState = {
  id: string
  provider: ProviderLoginRequest['provider']
  status: 'starting' | 'waiting' | 'complete' | 'error' | 'cancelled'
  authorizationUrl?: string
  userCode?: string
  canSubmitCode?: boolean
  error?: string
}
