import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import {
  prepareSkippedOnboardingPreferences,
  remapOpenOnboardingLastCompletedStep
} from './onboarding-flow-state'
import { getDefaultOnboardingState } from '../../../../shared/constants'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() }
}))

describe('prepareSkippedOnboardingPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('surfaces theme restore persistence failures without throwing', async () => {
    const setTheme = vi.fn()
    const applyTheme = vi.fn()
    const updateSettings = vi.fn().mockRejectedValue(new Error('settings IPC failed'))
    const setError = vi.fn()

    await expect(
      prepareSkippedOnboardingPreferences({
        currentStepId: 'theme',
        themeBeforePreview: 'dark',
        settingsTheme: 'light',
        selectedAgent: null,
        setTheme,
        applyTheme,
        updateSettings,
        setError
      })
    ).resolves.toBe(false)

    expect(setTheme).toHaveBeenCalledWith('dark')
    expect(applyTheme).toHaveBeenCalledWith('dark')
    expect(updateSettings).toHaveBeenCalledWith({ theme: 'dark' })
    expect(setError).toHaveBeenCalledWith('settings IPC failed')
    expect(toast.error).toHaveBeenCalledWith('Could not save progress', {
      description: 'settings IPC failed'
    })
  })

  it('keeps the selected agent preference before opening project setup', async () => {
    const setTheme = vi.fn()
    const applyTheme = vi.fn()
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const setError = vi.fn()

    await expect(
      prepareSkippedOnboardingPreferences({
        currentStepId: 'agent',
        themeBeforePreview: null,
        settingsTheme: 'light',
        selectedAgent: 'codex',
        setTheme,
        applyTheme,
        updateSettings,
        setError
      })
    ).resolves.toBe(true)

    expect(setTheme).not.toHaveBeenCalled()
    expect(applyTheme).not.toHaveBeenCalled()
    expect(updateSettings).toHaveBeenCalledWith({ defaultTuiAgent: 'codex' })
    expect(setError).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('persists primaryAi and conversationLaunchDefaults when skipping from the agent step with model and billing selected', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined)

    await expect(
      prepareSkippedOnboardingPreferences({
        currentStepId: 'agent',
        themeBeforePreview: null,
        settingsTheme: 'dark',
        selectedAgent: 'claude',
        selectedModel: 'claude-opus-5-5',
        selectedBilling: 'omnirogue-credits',
        conversationLaunchDefaults: { claude: { effort: 'high' } },
        setTheme: vi.fn(),
        applyTheme: vi.fn(),
        updateSettings,
        setError: vi.fn()
      })
    ).resolves.toBe(true)

    expect(updateSettings).toHaveBeenCalledWith({
      defaultTuiAgent: 'claude',
      primaryAi: {
        agent: 'claude',
        model: 'claude-opus-5-5',
        billing: 'omnirogue-credits'
      },
      conversationLaunchDefaults: {
        claude: {
          effort: 'high',
          model: 'claude-opus-5-5'
        }
      }
    })
  })
})

describe('remapOpenOnboardingLastCompletedStep', () => {
  it('remaps unversioned seven-step open progress to the current flow', () => {
    const base = { ...getDefaultOnboardingState(), flowVersion: 1 }

    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 3 })).toBe(3)
    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 4 })).toBe(3)
    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 5 })).toBe(4)
    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 9 })).toBe(4)
  })

  it('remaps versioned five-step open progress to the current flow', () => {
    const base = { ...getDefaultOnboardingState(), flowVersion: 2 }

    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 3 })).toBe(3)
    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 4 })).toBe(4)
    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 5 })).toBe(4)
    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 9 })).toBe(4)
  })

  it('remaps versioned four-step open progress around the inserted account and Windows steps', () => {
    const base = { ...getDefaultOnboardingState(), flowVersion: 3 }

    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 3 })).toBe(4)
    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 4 })).toBe(5)
    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 9 })).toBe(5)
  })

  it('remaps version 4 five-step open progress around the prepended OmniRogue account step', () => {
    const base = { ...getDefaultOnboardingState(), flowVersion: 4 }

    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 1 })).toBe(2)
    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 2 })).toBe(3)
    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 3 })).toBe(4)
    expect(remapOpenOnboardingLastCompletedStep({ ...base, lastCompletedStep: 4 })).toBe(5)
  })

  it('keeps current six-step progress intact', () => {
    expect(
      remapOpenOnboardingLastCompletedStep({
        ...getDefaultOnboardingState(),
        lastCompletedStep: 3
      })
    ).toBe(3)
  })

  it('maps unversioned completed onboarding to the current final step', () => {
    expect(
      remapOpenOnboardingLastCompletedStep({
        ...getDefaultOnboardingState(),
        flowVersion: 1,
        outcome: 'completed',
        lastCompletedStep: 7
      })
    ).toBe(6)
  })
})
