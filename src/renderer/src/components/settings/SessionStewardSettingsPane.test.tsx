// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSessionStewardSettings } from '../../../../shared/session-steward-settings'
import { SessionStewardSettingsPane } from './SessionStewardSettingsPane'

const store = vi.hoisted(() => ({ state: { settings: null as unknown, settingsSearchQuery: '' } }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof store.state) => unknown) => selector(store.state),
    { getState: () => store.state }
  )
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const LABELS = [
  'Let the session steward look after sessions',
  'Say yes to safe next steps',
  'Nudge sessions that stopped with work left',
  'Archive finished sessions',
  'Clean up sessions nobody prompted',
  'Clean up when leftovers pile up',
  'Let sessions wait for another session',
  'Keep sessions others are waiting on'
]

function renderPane(sessionSteward: GlobalSettings['sessionSteward'], refuse?: string) {
  const settings = { sessionSteward } as GlobalSettings
  store.state.settings = settings
  const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
    if (refuse) {
      throw new Error(refuse)
    }
    store.state.settings = { ...settings, ...updates }
  })
  render(<SessionStewardSettingsPane settings={settings} updateSettings={updateSettings} />)
  return updateSettings
}

const toggle = (name: string) => screen.getByRole('switch', { name })

it('shows one row per switch, all on for a profile that never set them', () => {
  renderPane(undefined)
  for (const name of LABELS) {
    expect(toggle(name).getAttribute('aria-checked')).toBe('true')
  }
})

it('persists each switch as its own kill switch, keeping the others', async () => {
  const updateSettings = renderPane(getDefaultSessionStewardSettings())
  fireEvent.click(toggle('Say yes to safe next steps'))
  await waitFor(() =>
    expect(updateSettings).toHaveBeenLastCalledWith({
      sessionSteward: { ...getDefaultSessionStewardSettings(), safeYes: 'off' }
    })
  )
  fireEvent.click(toggle('Clean up when leftovers pile up'))
  await waitFor(() =>
    expect(updateSettings).toHaveBeenLastCalledWith({
      sessionSteward: {
        ...getDefaultSessionStewardSettings(),
        safeYes: 'off',
        automaticCleanup: false
      }
    })
  )
})

it('greys out every switch while the steward itself is off', () => {
  renderPane({ ...getDefaultSessionStewardSettings(), enabled: false, tier2Archive: 'shadow' })
  expect(toggle(LABELS[0]!).getAttribute('aria-checked')).toBe('false')
  for (const name of LABELS.slice(1)) {
    expect(toggle(name).hasAttribute('disabled')).toBe(true)
  }
  // A diagnostic shadow value reads as not on.
  expect(toggle('Archive finished sessions').getAttribute('aria-checked')).toBe('false')
})

it('tells the person when a switch could not be saved', async () => {
  renderPane(undefined, 'Settings are read-only.')
  fireEvent.click(toggle('Archive finished sessions'))
  expect((await screen.findByRole('alert')).textContent).toContain('Settings are read-only.')
})

it('sets how long a blank session sits untouched (2 min by default), shown only while on', async () => {
  const updateSettings = renderPane(getDefaultSessionStewardSettings())
  const minutes = screen.getByRole('spinbutton', {
    name: 'Quiet time before cleanup'
  }) as HTMLInputElement
  expect(minutes.value).toBe('2')
  fireEvent.change(minutes, { target: { value: '1' } })
  fireEvent.blur(minutes)
  await waitFor(() =>
    expect(updateSettings).toHaveBeenLastCalledWith({
      sessionSteward: { ...getDefaultSessionStewardSettings(), emptySessionCloseMinutes: 1 }
    })
  )
  cleanup()
  renderPane({ ...getDefaultSessionStewardSettings(), emptySessionArchive: false })
  expect(screen.queryByRole('spinbutton', { name: 'Quiet time before cleanup' })).toBeNull()
})

it('closes blank sessions by default and can be set to archive them instead', async () => {
  const updateSettings = renderPane(getDefaultSessionStewardSettings())
  expect(screen.getByRole('radio', { name: 'Close' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('radio', { name: 'Archive' }))
  await waitFor(() =>
    expect(updateSettings).toHaveBeenLastCalledWith({
      sessionSteward: { ...getDefaultSessionStewardSettings(), emptySessionAction: 'archive' }
    })
  )
})
