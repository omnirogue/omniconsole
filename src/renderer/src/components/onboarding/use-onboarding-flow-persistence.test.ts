// @vitest-environment happy-dom

import { createElement, useEffect, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import {
  applyAgentPermissionMode,
  YOLO_TUI_AGENT_ARGS
} from '../../../../shared/tui-agent-permissions'

const trackMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/telemetry', () => ({
  track: trackMock
}))

import {
  buildCompletedOnboardingNotificationSettings,
  buildOnboardingAgentStepSettingsUpdate,
  buildOnboardingDismissedPayload,
  resolveOnboardingYoloPermissions,
  useCloseWith,
  usePersistCurrentStep,
  type DismissedExtras,
  type PersistCurrentStepResult,
  trackOnboardingDismissed
} from './use-onboarding-flow-persistence'
import type { StepNumber } from './use-onboarding-flow-types'

type CloseWithCallback = (
  outcome: 'completed' | 'dismissed',
  lastStepReached: StepNumber,
  completedPath?: 'add_project_modal',
  dismissedExtras?: DismissedExtras
) => Promise<boolean>

const probeStartTime = Date.now()

function makeOnboardingState(): OnboardingState {
  return {
    ...getDefaultOnboardingState(),
    closedAt: Date.now(),
    outcome: 'completed',
    lastCompletedStep: 6
  }
}

function setApi(api: {
  onboarding: { update: ReturnType<typeof vi.fn> }
  starNag: { onboardingCompleted: ReturnType<typeof vi.fn> }
}): void {
  ;(window as unknown as { api: typeof api }).api = api
}

function CloseWithProbe(props: { onReady: (closeWith: CloseWithCallback) => void }): null {
  const closeWith = useCloseWith({
    onOnboardingChange: vi.fn(),
    startTimeRef: { current: probeStartTime },
    setError: vi.fn()
  })
  useEffect(() => props.onReady(closeWith), [closeWith, props])
  return null
}

function renderCloseWithProbe(onReady: (closeWith: CloseWithCallback) => void): {
  root: Root
  container: HTMLDivElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(CloseWithProbe, { onReady })))
  return { root, container }
}

type PersistCurrentStepProbeDeps = Parameters<typeof usePersistCurrentStep>[0]

function PersistCurrentStepProbe(props: {
  deps: PersistCurrentStepProbeDeps
  onReady: (persist: () => Promise<PersistCurrentStepResult>) => void
}): null {
  const persist = usePersistCurrentStep(props.deps)
  useEffect(() => props.onReady(persist), [persist, props])
  return null
}

function renderPersistProbe(
  deps: PersistCurrentStepProbeDeps,
  onReady: (persist: () => Promise<PersistCurrentStepResult>) => void
): {
  root: Root
  container: HTMLDivElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(PersistCurrentStepProbe, { deps, onReady })))
  return { root, container }
}

describe('onboarding flow persistence', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    trackMock.mockClear()
    setApi({
      onboarding: { update: vi.fn().mockResolvedValue(makeOnboardingState()) },
      starNag: { onboardingCompleted: vi.fn().mockResolvedValue(undefined) }
    })
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
    vi.useRealTimers()
  })

  it('builds dismissed telemetry with the triggering advance path', () => {
    expect(
      buildOnboardingDismissedPayload(3, {
        durationMs: 250,
        advancedVia: 'keyboard'
      })
    ).toEqual({
      last_step: 3,
      duration_ms: 250,
      advanced_via: 'keyboard'
    })
  })

  it('tracks dismissed onboarding telemetry with the triggering advance path', () => {
    trackOnboardingDismissed(3, {
      durationMs: 250,
      advancedVia: 'keyboard'
    })

    expect(trackMock).toHaveBeenCalledWith('onboarding_dismissed', {
      last_step: 3,
      duration_ms: 250,
      advanced_via: 'keyboard'
    })
  })

  it('preserves explicit focus notification suppression when completing onboarding', () => {
    const notifications = buildCompletedOnboardingNotificationSettings({
      enabled: false,
      agentTaskComplete: false,
      workNotice: true,
      terminalBell: false,
      suppressWhenFocused: false,
      customSoundId: 'two-tone',
      customSoundPath: null,
      customSoundVolume: 60
    })

    expect(notifications).toEqual({
      enabled: true,
      agentTaskComplete: true,
      workNotice: true,
      terminalBell: true,
      suppressWhenFocused: false,
      customSoundId: 'two-tone',
      customSoundPath: null,
      customSoundVolume: 60
    })
  })

  it('schedules the star toast after every completed close path', async () => {
    let closeWith: CloseWithCallback | null = null
    ;({ root, container } = renderCloseWithProbe((callback) => {
      closeWith = callback
    }))

    await act(async () => {
      await closeWith?.('completed', 6)
    })

    const api = (
      window as unknown as {
        api: {
          starNag: { onboardingCompleted: ReturnType<typeof vi.fn> }
        }
      }
    ).api
    expect(api.starNag.onboardingCompleted).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(api.starNag.onboardingCompleted).toHaveBeenCalledTimes(1)
  })

  it('does not treat restricted presets as yolo when reopening onboarding', () => {
    const planSettings = {
      ...getDefaultSettings('/tmp'),
      ...applyAgentPermissionMode({
        mode: 'plan',
        agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
        agentDefaultEnv: {}
      })
    }
    const readOnlySettings = {
      ...getDefaultSettings('/tmp'),
      ...applyAgentPermissionMode({
        mode: 'read-only',
        agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
        agentDefaultEnv: {}
      })
    }

    expect(resolveOnboardingYoloPermissions(planSettings)).toBe(false)
    expect(resolveOnboardingYoloPermissions(readOnlySettings)).toBe(false)
    expect(resolveOnboardingYoloPermissions(getDefaultSettings('/tmp'))).toBe(true)
    expect(
      resolveOnboardingYoloPermissions({
        ...getDefaultSettings('/tmp'),
        agentDefaultArgs: {}
      })
    ).toBe(false)
  })

  it.each(['plan', 'read-only'] as const)(
    'leaves %s launch flags untouched when onboarding continues without changing permissions',
    async (preset) => {
      const restricted = applyAgentPermissionMode({
        mode: preset,
        agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
        agentDefaultEnv: {}
      })
      const settings: GlobalSettings = {
        ...getDefaultSettings('/tmp'),
        ...restricted
      }
      const updateSettings = vi.fn().mockResolvedValue(undefined)
      let persistCurrentStep: (() => Promise<PersistCurrentStepResult>) | null = null
      ;({ root, container } = renderPersistProbe(
        {
          currentStepId: 'agent',
          selectedAgent: 'claude',
          yoloPermissions: true,
          yoloPermissionsChanged: false,
          theme: 'dark',
          settings,
          updateSettings,
          onboardingChecklist: getDefaultOnboardingState().checklist,
          onOnboardingChange: vi.fn(),
          setError: vi.fn()
        },
        (persist) => {
          persistCurrentStep = persist
        }
      ))

      await act(async () => {
        await persistCurrentStep?.()
      })

      expect(updateSettings).toHaveBeenCalledTimes(1)
      const updates = updateSettings.mock.calls[0]?.[0] as Partial<GlobalSettings>
      expect(updates.defaultTuiAgent).toBe('claude')
      expect(updates.agentDefaultArgs).toBeUndefined()
      expect(updates.agentDefaultEnv).toBeUndefined()
      expect(settings.agentDefaultArgs?.claude).toBe('--permission-mode plan')
      expect(settings.agentDefaultArgs?.claude).not.toBe('--dangerously-skip-permissions')
      expect(settings.agentDefaultArgs?.codex).not.toBe(
        '--dangerously-bypass-approvals-and-sandbox'
      )
      if (preset === 'plan') {
        expect(settings.agentDefaultArgs?.codex).toBe('')
      } else {
        expect(settings.agentDefaultArgs?.codex).toBe('-s read-only -a never')
      }
    }
  )

  it('writes yolo flags only after an explicit onboarding permission change and persists primaryAi', () => {
    const restricted = applyAgentPermissionMode({
      mode: 'plan',
      agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
      agentDefaultEnv: {}
    })
    const settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      ...restricted
    }

    expect(
      buildOnboardingAgentStepSettingsUpdate({
        selectedAgent: 'claude',
        yoloPermissions: true,
        yoloPermissionsChanged: false,
        settings
      }).agentDefaultArgs
    ).toBeUndefined()

    const explicitYolo = buildOnboardingAgentStepSettingsUpdate({
      selectedAgent: 'claude',
      selectedModel: 'claude-opus-5-5',
      selectedBilling: 'omnirogue-credits',
      yoloPermissions: true,
      yoloPermissionsChanged: true,
      settings
    })
    expect(explicitYolo.agentDefaultArgs?.claude).toBe('--dangerously-skip-permissions')
    expect(explicitYolo.agentDefaultArgs?.codex).toBe('--dangerously-bypass-approvals-and-sandbox')
    expect(explicitYolo.primaryAi).toEqual({
      agent: 'claude',
      model: 'claude-opus-5-5',
      billing: 'omnirogue-credits'
    })
    expect(explicitYolo.conversationLaunchDefaults?.claude?.model).toBe('claude-opus-5-5')
  })
})
