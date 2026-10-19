import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import OnboardingFlow from './OnboardingFlow'
import { ONBOARDING_SKIP_CONFIRMATION_COPY } from './OnboardingSkipConfirmationDialog'

function renderOnboardingFlow(props: ComponentProps<typeof OnboardingFlow>): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <OnboardingFlow {...props} />
    </TooltipProvider>
  )
}

describe('OnboardingFlow', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      repos: [],
      settings: getDefaultSettings('/tmp')
    })
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  })

  afterEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.unstubAllGlobals()
  })

  it('renders Step 1 Create or Connect your OmniRogue Account on initial open', () => {
    const html = renderOnboardingFlow({
      onboarding: getDefaultOnboardingState(),
      onOnboardingChange: vi.fn()
    })

    expect(html).toContain('Create or Connect your OmniRogue Account (Recommended)')
    expect(html).toContain('Connect OmniRogue Account')
    expect(html).toContain('Create OmniRogue Account')
    expect(html).toContain('Use my own local CLI login')
  })

  it('renders Step 2 Choose your Primary AI &amp; Default Model with flagship models', () => {
    const html = renderOnboardingFlow({
      onboarding: {
        ...getDefaultOnboardingState(),
        lastCompletedStep: 1
      },
      onOnboardingChange: vi.fn()
    })

    expect(html).toContain('Choose your Primary AI &amp; Default Model')
    expect(html).toContain('OmniRogue Cloud Credits (Recommended)')
    expect(html).toContain('Claude Opus 5.5')
    expect(html).toContain('Claude Sonnet 4.6')
    expect(html).toContain('GPT-6 Astra')
    expect(html).toContain('Gemini 4 Argon')
    expect(html).toContain('Kimi K3')
  })

  it('does not render the removed agent setup or tour steps', () => {
    const html = renderOnboardingFlow({
      onboarding: {
        ...getDefaultOnboardingState(),
        lastCompletedStep: 4
      },
      onOnboardingChange: vi.fn()
    })

    expect(html).toContain('Set up notifications')
    expect(html).not.toContain('Set up Orca for agents')
    expect(html).not.toContain('Explore Orca')
    expect(html).not.toContain('Take the tour')
    expect(html).toContain('Add your first project')
    expect(html).not.toContain('Point Orca at some code')
  })

  it.each([
    [3, 'Set up GitHub tasks'],
    [4, 'Set up GitHub tasks'],
    [5, 'Set up notifications'],
    [9, 'Set up notifications']
  ])(
    'resumes unversioned seven-step onboarding progress %i at the matching current page',
    (legacyStep, title) => {
      const html = renderOnboardingFlow({
        onboarding: {
          ...getDefaultOnboardingState(),
          flowVersion: 1,
          lastCompletedStep: legacyStep
        },
        onOnboardingChange: vi.fn()
      })

      expect(html).toContain(title)
      expect(html).not.toContain('Set up Orca for agents')
      expect(html).not.toContain('Explore Orca')
    }
  )

  it.each([
    [3, 'Set up GitHub tasks'],
    [4, 'Set up notifications'],
    [5, 'Set up notifications'],
    [9, 'Set up notifications']
  ])(
    'resumes versioned five-step onboarding progress %i at the matching current page',
    (legacyStep, title) => {
      const html = renderOnboardingFlow({
        onboarding: {
          ...getDefaultOnboardingState(),
          flowVersion: 2,
          lastCompletedStep: legacyStep
        },
        onOnboardingChange: vi.fn()
      })

      expect(html).toContain(title)
      expect(html).not.toContain('Set up Orca for agents')
      expect(html).not.toContain('Explore Orca')
    }
  )

  it.each([
    [3, 'Set up notifications'],
    [4, 'Set up notifications'],
    [9, 'Set up notifications']
  ])(
    'resumes versioned four-step onboarding progress %i without showing Windows setup on Mac',
    (legacyStep, title) => {
      const html = renderOnboardingFlow({
        onboarding: {
          ...getDefaultOnboardingState(),
          flowVersion: 3,
          lastCompletedStep: legacyStep
        },
        onOnboardingChange: vi.fn()
      })

      expect(html).toContain(title)
      expect(html).not.toContain('Set Windows terminal defaults')
    }
  )

  it('shows the Windows terminal defaults page for Windows users after integrations', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })

    const html = renderOnboardingFlow({
      onboarding: {
        ...getDefaultOnboardingState(),
        lastCompletedStep: 4
      },
      onOnboardingChange: vi.fn()
    })

    expect(html).toContain('Set Windows terminal defaults')
    expect(html).toContain('5 of 6')
  })

  it('drops the skipped integrations step from the stepper on Windows', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    useAppStore.setState({
      preflightStatus: {
        git: { installed: true },
        gh: { installed: true, authenticated: false }
      },
      preflightStatusChecked: true
    })

    const html = renderOnboardingFlow({
      onboarding: {
        ...getDefaultOnboardingState(),
        lastCompletedStep: 3
      },
      onOnboardingChange: vi.fn()
    })

    expect(html).toContain('Set Windows terminal defaults')
    // Why: integrations is skipped (gh already installed), so it is not a
    // stepper dot at all — the five real steps are account, agent, theme, Windows
    // terminal, notifications, and Windows terminal is the fourth of five.
    expect(html).toContain('4 of 5')
    expect(html).not.toContain('Set up GitHub tasks')
    expect(html).not.toContain('Integrations')
  })

  it('skips GitHub task setup when the GitHub CLI is already detected', () => {
    useAppStore.setState({
      preflightStatus: {
        git: { installed: true },
        gh: { installed: true, authenticated: false }
      },
      preflightStatusChecked: true
    })

    const html = renderOnboardingFlow({
      onboarding: {
        ...getDefaultOnboardingState(),
        lastCompletedStep: 3
      },
      onOnboardingChange: vi.fn()
    })

    expect(html).toContain('Set up notifications')
    expect(html).toContain('Add your first project')
    expect(html).not.toContain('Set up GitHub tasks')
    expect(html).not.toContain('Connect your task sources')
    expect(html).not.toContain('Point Orca at some code')
    // Why: with both integrations (gh installed) and Windows terminal (Mac)
    // skipped, the stepper shows only the four real steps — no dead dots.
    expect(html).toContain('4 of 4')
    expect(html).not.toContain('Integrations')
  })

  it('shows only GitHub on the task setup page when the GitHub CLI is missing', () => {
    useAppStore.setState({
      preflightStatus: {
        git: { installed: true },
        gh: { installed: false, authenticated: false }
      },
      preflightStatusChecked: true
    })

    const html = renderOnboardingFlow({
      onboarding: {
        ...getDefaultOnboardingState(),
        lastCompletedStep: 3
      },
      onOnboardingChange: vi.fn()
    })

    expect(html).toContain('Set up GitHub tasks')
    expect(html).toContain('Install the GitHub CLI to:')
    expect(html).toContain('GitHub')
    expect(html).not.toContain(
      '<h3 class="text-[15px] font-semibold leading-tight text-foreground">Linear</h3>'
    )
    expect(html).toContain(
      'Linear, GitLab, Bitbucket, Azure DevOps, Gitea, and Jira live in Settings'
    )
  })

  it('renders onboarding inside a centered modal shell', () => {
    const html = renderOnboardingFlow({
      onboarding: getDefaultOnboardingState(),
      onOnboardingChange: vi.fn()
    })

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('data-onboarding-modal="true"')
    expect(html).toContain('h-[calc(100vh-2rem)]')
    expect(html).toContain('rounded-xl')
    expect(html).toContain('class="h-7 w-auto shrink-0"')
    expect(html).not.toContain('min-h-screen')
    expect(html).not.toContain('background-color:#12181e')
  })

  it('renders concise skip confirmation copy', () => {
    expect(ONBOARDING_SKIP_CONFIRMATION_COPY).toEqual({
      title: 'Skip onboarding?',
      description: "It won't take long!",
      skipLabel: 'Skip',
      keepGoingLabel: 'No, keep going'
    })
  })
})
