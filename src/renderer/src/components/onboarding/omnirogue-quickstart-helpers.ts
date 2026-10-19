import type { OmniRogueAccountState } from '../../../../shared/omnirogue-account'

export type OmniRogueQuickStartLabels = {
  title: string
  description: string
  connect: string
  signup: string
  continue: string
  waiting: string
  working: string
  connected: string
  disconnected: string
  ownLogin: string
  ownLoginDescription: string
  ownLoginSelected: string
  connectionError: string
  actionError: string
}

export const DEFAULT_OMNIROGUE_QUICK_START_LABELS: Readonly<OmniRogueQuickStartLabels> = {
  title: 'Get started with OmniRogue',
  description: 'Connect your account to use models with your OmniRogue wallet.',
  connect: 'Connect OmniRogue account',
  signup: 'Create an account',
  continue: 'Continue',
  waiting: 'Waiting for browser…',
  working: 'Working…',
  connected: 'Connected to OmniRogue',
  disconnected: 'Connect an account to get started.',
  ownLogin: 'Use my own CLI login',
  ownLoginDescription: 'You can also use your existing local CLI login.',
  ownLoginSelected: 'Your own CLI login is selected.',
  connectionError: 'Could not connect your OmniRogue account. Try again.',
  actionError: 'Could not complete this action. Try again.'
}

export function resolveOmniRogueQuickStartLabels(
  overrides?: Partial<OmniRogueQuickStartLabels>
): OmniRogueQuickStartLabels {
  const labels = { ...DEFAULT_OMNIROGUE_QUICK_START_LABELS }
  if (overrides) {
    for (const key of Object.keys(labels) as (keyof OmniRogueQuickStartLabels)[]) {
      const value = overrides[key]
      if (value !== undefined) {
        labels[key] = value
      }
    }
  }
  return labels
}

export function getOmniRogueQuickStartState(
  accountState: OmniRogueAccountState,
  labels: OmniRogueQuickStartLabels = DEFAULT_OMNIROGUE_QUICK_START_LABELS
): {
  isConnected: boolean
  isConnecting: boolean
  accountSummary: string | null
  errorMessage: string | null
} {
  const isConnected = accountState.state === 'connected' || accountState.state === 'linked'
  const isConnecting = accountState.state === 'connecting' || accountState.state === 'linking'
  const hasError =
    !isConnected && !isConnecting && (accountState.state === 'error' || Boolean(accountState.error))
  const identity = accountState.email?.trim() || accountState.displayName?.trim()
  const accountSummary = isConnected
    ? [identity, accountState.orgName?.trim()].filter(Boolean).join(' · ') || null
    : null

  return {
    isConnected,
    isConnecting,
    accountSummary,
    errorMessage: hasError ? accountState.lastError?.trim() || labels.connectionError : null
  }
}
