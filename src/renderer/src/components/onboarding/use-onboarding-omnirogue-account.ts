import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type {
  OmniRogueAccountState,
  PrimaryAiBillingMode
} from '../../../../shared/omnirogue-account'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  defaultFlagshipModelForAgent,
  FLAGSHIP_PRIMARY_AI_MODELS
} from './use-onboarding-flow-types'

const DEFAULT_ACCOUNT_STATE: OmniRogueAccountState = {
  state: 'disconnected',
  email: null,
  orgName: null,
  pendingSince: null,
  lastError: null
}

const OMNIROGUE_SIGNUP_URL = 'https://omnirogue.com/signup'

type UseOnboardingOmniRogueAccountArgs = {
  settings: GlobalSettings | null
  selectedAgent: TuiAgent | null
  setSelectedAgent: (agent: TuiAgent | null, fromCollapsedSection?: boolean) => void
}

export type UseOnboardingOmniRogueAccountReturn = {
  accountState: OmniRogueAccountState
  isAccountBusy: boolean
  selectedBilling: PrimaryAiBillingMode
  selectedModel: string | undefined
  setSelectedBilling: (mode: PrimaryAiBillingMode) => void
  selectFlagshipModel: (modelId: string, agent?: TuiAgent) => void
  connectAccount: () => Promise<void>
  disconnectAccount: () => Promise<void>
  openSignup: () => Promise<void>
}

export function resolveInitialPrimaryAiModel(
  settings: GlobalSettings | null | undefined,
  agent: TuiAgent | null
): string | undefined {
  if (settings?.primaryAi?.model) {
    return settings.primaryAi.model
  }
  if (agent && settings?.conversationLaunchDefaults?.[agent]?.model) {
    return settings.conversationLaunchDefaults[agent]?.model
  }
  return defaultFlagshipModelForAgent(agent) ?? 'claude-opus-5-5'
}

export function useOnboardingOmniRogueAccount({
  settings,
  selectedAgent,
  setSelectedAgent
}: UseOnboardingOmniRogueAccountArgs): UseOnboardingOmniRogueAccountReturn {
  const [accountState, setAccountState] = useState<OmniRogueAccountState>(DEFAULT_ACCOUNT_STATE)
  const [isAccountBusy, setIsAccountBusy] = useState(false)
  const [selectedBilling, setSelectedBillingState] = useState<PrimaryAiBillingMode>(
    // Why: credits billing needs a linked account; the status probe below switches to credits once linked.
    settings?.primaryAi?.billing ?? 'own-login'
  )
  const [selectedModel, setSelectedModelState] = useState<string | undefined>(() =>
    resolveInitialPrimaryAiModel(settings, selectedAgent)
  )
  const [previousPrimaryAi, setPreviousPrimaryAi] = useState(settings?.primaryAi)

  const billingInteractedRef = useRef(false)
  const modelInteractedRef = useRef(false)
  const [previousAgent, setPreviousAgent] = useState(selectedAgent)

  if (previousAgent !== selectedAgent) {
    setPreviousAgent(selectedAgent)
    const currentFlagship = FLAGSHIP_PRIMARY_AI_MODELS.find((m) => m.id === selectedModel)
    if (!currentFlagship || (selectedAgent && currentFlagship.agent !== selectedAgent)) {
      const nextModel =
        (selectedAgent && settings?.conversationLaunchDefaults?.[selectedAgent]?.model) ??
        defaultFlagshipModelForAgent(selectedAgent)
      if (nextModel !== selectedModel) {
        setSelectedModelState(nextModel)
      }
    }
  }

  if (settings?.primaryAi !== previousPrimaryAi) {
    setPreviousPrimaryAi(settings?.primaryAi)
    if (!billingInteractedRef.current && settings?.primaryAi?.billing) {
      setSelectedBillingState(settings.primaryAi.billing)
    }
    if (!modelInteractedRef.current && settings?.primaryAi?.model) {
      setSelectedModelState(settings.primaryAi.model)
    }
  }

  useEffect(() => {
    const accountApi = window.api?.omnirogue?.account
    if (!accountApi) {
      return
    }
    let cancelled = false
    void accountApi
      .status()
      .then((status) => {
        if (cancelled || !status) {
          return
        }
        setAccountState(status)
        if ((status.state === 'connected' || status.state === 'linked') && !billingInteractedRef.current) {
          setSelectedBillingState('omnirogue-credits')
        }
      })
      .catch(() => {
        // Ignore status probe errors in environments without the main handler wired
      })

    const unsubscribe = accountApi.onStatusChanged?.((next) => {
      if (cancelled || !next) {
        return
      }
      setAccountState(next)
      if ((next.state === 'connected' || next.state === 'linked') && !billingInteractedRef.current) {
        setSelectedBillingState('omnirogue-credits')
      }
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  const setSelectedBilling = useCallback((mode: PrimaryAiBillingMode) => {
    billingInteractedRef.current = true
    setSelectedBillingState(mode)
  }, [])

  const selectFlagshipModel = useCallback(
    (modelId: string, agent?: TuiAgent) => {
      modelInteractedRef.current = true
      setSelectedModelState(modelId)
      if (agent && agent !== selectedAgent) {
        setSelectedAgent(agent, false)
      }
    },
    [selectedAgent, setSelectedAgent]
  )

  const connectAccount = useCallback(async () => {
    const accountApi = window.api?.omnirogue?.account
    if (!accountApi?.link) {
      return
    }
    setIsAccountBusy(true)
    try {
      const next = await accountApi.link()
      if (next) {
        setAccountState(next)
        if (next.state === 'connected' || next.state === 'linked') {
          setSelectedBillingState('omnirogue-credits')
        }
      }
    } finally {
      setIsAccountBusy(false)
    }
  }, [])

  const disconnectAccount = useCallback(async () => {
    const accountApi = window.api?.omnirogue?.account
    if (!accountApi?.unlink) {
      return
    }
    setIsAccountBusy(true)
    try {
      const next = await accountApi.unlink()
      if (next) {
        setAccountState(next)
      }
    } finally {
      setIsAccountBusy(false)
    }
  }, [])

  const openSignup = useCallback(async () => {
    await window.api.shell.openUrl(OMNIROGUE_SIGNUP_URL)
  }, [])

  return {
    accountState,
    isAccountBusy,
    selectedBilling,
    selectedModel,
    setSelectedBilling,
    selectFlagshipModel,
    connectAccount,
    disconnectAccount,
    openSignup
  }
}
