// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { ChatUsageButton, usageLevel } from './ChatUsageButton'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    ),
  i18n: { language: 'en' }
}))

const NOW = Date.parse('2026-09-11T20:00:00.000Z')
function window(usedPercent: number, minutes: number): RateLimitWindow {
  return {
    usedPercent,
    windowMinutes: minutes,
    resetsAt: NOW + 2 * 3_600_000,
    resetDescription: null
  }
}
function provider(
  id: ProviderRateLimits['provider'],
  session: number,
  weekly: number
): ProviderRateLimits {
  return {
    provider: id,
    status: 'ok',
    planType: 'max',
    session: window(session, 300),
    weekly: window(weekly, 10_080),
    fableWeekly: null,
    error: null
  } as unknown as ProviderRateLimits
}

const store = vi.hoisted(() => ({
  refreshRateLimits: vi.fn(async () => true),
  openSettingsTarget: vi.fn(),
  openSettingsPage: vi.fn(),
  state: {} as Record<string, unknown>
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(store.state)
}))

function seed(providers: Partial<Record<'claude' | 'codex' | 'gemini', ProviderRateLimits>>) {
  store.state = {
    rateLimits: {
      claude: providers.claude ?? null,
      codex: providers.codex ?? null,
      gemini: providers.gemini ?? null,
      opencodeGo: null,
      kimi: null,
      antigravity: null,
      minimax: null,
      grok: null,
      minimaxCookieConfigured: false,
      grokAuthConfigured: false,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    },
    settings: {},
    detectedAgentIds: ['claude', 'codex', 'gemini'],
    usagePercentageDisplay: 'remaining',
    refreshRateLimits: store.refreshRateLimits,
    openSettingsTarget: store.openSettingsTarget,
    openSettingsPage: store.openSettingsPage
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ChatUsageButton', () => {
  it('shows the active Codex balance even when Claude is nearly exhausted', async () => {
    seed({ claude: provider('claude', 72, 94), codex: provider('codex', 0, 2) })
    render(
      <TooltipProvider>
        <ChatUsageButton agent="codex" />
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: /^Usage · / })
    expect(button.getAttribute('data-chat-usage-level')).toBe('fine')
    expect(button.getAttribute('aria-label')).toBe('Usage · Codex · 98% left')
    expect(button.textContent).toBe('Codex · 98% left')
    expect(screen.queryByText('Claude')).toBeNull()
    await act(async () => {
      fireEvent.click(button)
    })
    const rows = await screen.findAllByRole('listitem')
    expect(rows.map((row) => row.getAttribute('data-chat-usage-provider'))).toEqual([
      'codex',
      'claude'
    ])
    expect(rows[0]?.getAttribute('data-chat-usage-level')).toBe('fine')
    expect(rows[1]?.getAttribute('data-chat-usage-level')).toBe('critical')
    expect(screen.getAllByText(/^Resets /)).toHaveLength(2)
    expect(screen.queryByText(/Resets Resets/)).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
    })
    expect(store.refreshRateLimits).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'All usage details' }))
    expect(store.openSettingsTarget).toHaveBeenCalledWith({ pane: 'stats', repoId: null })
    expect(store.openSettingsPage).toHaveBeenCalled()
  })

  it('follows the conversation agent and the used/remaining preference on rerender', () => {
    seed({ claude: provider('claude', 94, 35), codex: provider('codex', 0, 2) })
    store.state.usagePercentageDisplay = 'used'
    const view = render(<ChatUsageButton agent="codex" />)
    expect(screen.getByRole('button', { name: 'Usage · Codex · 2% used' })).toBeTruthy()
    view.rerender(<ChatUsageButton agent="claude" />)
    expect(
      screen
        .getByRole('button', { name: 'Usage · Claude · 94% used' })
        .getAttribute('data-chat-usage-level')
    ).toBe('critical')
  })

  it.each(['codex', 'custom-agent'])(
    'does not borrow another provider when %s has no data',
    (agent) => {
      seed({ claude: provider('claude', 94, 35) })
      render(<ChatUsageButton agent={agent} />)
      const button = screen.getByRole('button', { name: /^Usage · / })
      expect(button.getAttribute('data-chat-usage-level')).toBe('unknown')
      expect(button.textContent).toContain('Usage unavailable')
      expect(button.textContent).not.toContain('Claude')
      expect(button.textContent).not.toContain('%')
    }
  )

  it('keeps active-provider usage when local agent detection has not found the CLI', () => {
    seed({ codex: provider('codex', 0, 2) })
    store.state.detectedAgentIds = []
    render(<ChatUsageButton agent="codex" />)
    expect(screen.getByRole('button', { name: 'Usage · Codex · 98% left' })).toBeTruthy()
  })

  it('marks cached usage as last known after a refresh error', async () => {
    seed({ codex: { ...provider('codex', 0, 2), status: 'error', error: 'Network failed' } })
    render(<ChatUsageButton agent="codex" />)
    const button = screen.getByRole('button', { name: 'Usage · Codex · Refresh failed' })
    expect(button.getAttribute('data-chat-usage-level')).toBe('unknown')
    fireEvent.click(button)
    expect(await screen.findByText('Last known usage · Refresh failed')).toBeTruthy()
  })

  it('treats malformed quota windows as unknown instead of a full battery', async () => {
    seed({ codex: provider('codex', Number.NaN, Number.POSITIVE_INFINITY) })
    render(<ChatUsageButton agent="codex" />)
    const button = screen.getByRole('button', { name: 'Usage · Codex · No usage data' })
    expect(button.getAttribute('data-chat-usage-level')).toBe('unknown')
    fireEvent.click(button)
    await screen.findByRole('listitem')
    expect(screen.queryByText(/100%/)).toBeNull()
    expect(document.querySelector('[data-usage-window]')).toBeNull()
  })

  it('opens on hover without stealing the composer focus', async () => {
    seed({ claude: provider('claude', 94, 35), codex: provider('codex', 0, 2) })
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(hover: hover)' }))
    render(
      <>
        <textarea aria-label="Message" />
        <ChatUsageButton agent="codex" />
      </>
    )
    const textarea = screen.getByRole('textbox')
    textarea.focus()
    fireEvent.pointerEnter(screen.getByRole('button', { name: /^Usage · / }))
    await screen.findByText('Claude')
    expect(document.activeElement).toBe(textarea)
  })

  it('supports keyboard opening and Escape returning focus to usage', async () => {
    seed({ codex: provider('codex', 0, 2) })
    render(<ChatUsageButton agent="codex" />)
    const button = screen.getByRole('button', { name: /^Usage · / })
    button.focus()
    fireEvent.keyDown(button, { key: 'Enter' })
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh usage' }))
    )
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(button))
  })

  it('reports a failed refresh and lets a later refresh clear the error', async () => {
    seed({ codex: provider('codex', 0, 2) })
    store.refreshRateLimits.mockResolvedValueOnce(false)
    render(<ChatUsageButton agent="codex" />)
    fireEvent.click(screen.getByRole('button', { name: /^Usage · / }))
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh usage' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Unable to refresh usage. Try again.'
    )
    expect(
      screen
        .getByRole('button', { name: 'Usage · Codex · Refresh failed' })
        .getAttribute('data-chat-usage-level')
    ).toBe('unknown')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' })))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(store.refreshRateLimits).toHaveBeenCalledTimes(2)
  })

  it('offers account set-up when no model is configured', async () => {
    seed({})
    render(
      <TooltipProvider>
        <ChatUsageButton />
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: /^Usage · / })
    expect(button.getAttribute('data-chat-usage-level')).toBe('unknown')
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText('No model accounts are set up yet.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set up accounts' }))
    expect(store.openSettingsTarget).toHaveBeenCalledWith({ pane: 'accounts', repoId: null })
  })

  it('maps the status-bar thresholds to levels', () => {
    expect(usageLevel(null)).toBe('unknown')
    expect(usageLevel(0)).toBe('fine')
    expect(usageLevel(59)).toBe('fine')
    expect(usageLevel(60)).toBe('warn')
    expect(usageLevel(80)).toBe('critical')
  })
})
