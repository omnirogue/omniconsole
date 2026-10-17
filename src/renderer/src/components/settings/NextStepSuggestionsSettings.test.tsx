// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { NextStepSuggestionsSettings } from './NextStepSuggestionsSettings'

const store = vi.hoisted(() => ({ state: { settings: null as unknown, settingsSearchQuery: '' } }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof store.state) => unknown) => selector(store.state),
    { getState: () => store.state }
  )
}))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderSettings(
  nextStepSuggestions: GlobalSettings['nextStepSuggestions'],
  refuse?: string
) {
  const settings = { nextStepSuggestions } as GlobalSettings
  store.state.settings = settings
  const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
    if (refuse) {
      throw new Error(refuse)
    }
    store.state.settings = { ...settings, ...updates }
  })
  render(<NextStepSuggestionsSettings settings={settings} updateSettings={updateSettings} />)
  return updateSettings
}

it('is on by default and persists turning it off, keeping the suggester choice', async () => {
  const updateSettings = renderSettings({ enabled: true, agent: 'codex', model: 'gpt-5.4' })
  const toggle = screen.getByRole('switch', { name: 'Suggest next steps after each AI turn' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  await waitFor(() =>
    expect(updateSettings).toHaveBeenCalledWith({
      nextStepSuggestions: { enabled: false, agent: 'codex', model: 'gpt-5.4' }
    })
  )
})

it('reads a missing setting as on', async () => {
  const updateSettings = renderSettings(undefined)
  const toggle = screen.getByRole('switch', { name: 'Suggest next steps after each AI turn' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  await waitFor(() =>
    expect(updateSettings).toHaveBeenCalledWith({ nextStepSuggestions: { enabled: false } })
  )
})

it('tells the person when the setting could not be saved', async () => {
  renderSettings({ enabled: true }, 'Settings are read-only.')
  fireEvent.click(screen.getByRole('switch', { name: 'Suggest next steps after each AI turn' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Settings are read-only.')
})

it('never lets an older failed write paint over a later success', async () => {
  let failFirst: (reason: Error) => void = () => undefined
  const settings = { nextStepSuggestions: { enabled: true } } as GlobalSettings
  store.state.settings = settings
  const updateSettings = vi
    .fn()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => (failFirst = reject)))
    .mockImplementationOnce(async () => undefined)
  render(<NextStepSuggestionsSettings settings={settings} updateSettings={updateSettings} />)
  const toggle = screen.getByRole('switch', { name: 'Suggest next steps after each AI turn' })
  fireEvent.click(toggle)
  fireEvent.click(toggle)
  await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2))
  failFirst(new Error('Too late.'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(screen.queryByRole('alert')).toBeNull()
})
