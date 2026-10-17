/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { launchSessionContextKey, setSessionContext } from '@/lib/session-context-store'
import { NewConversationMenu } from './NewConversationMenu'
import { getAgentSessionOptionCatalog } from '../../../../../../shared/agent-session-option-catalog'
const state = vi.hoisted(() => ({
  settings: {
    defaultTuiAgent: null,
    experimentalNativeChat: true,
    openAgentTabsInChatByDefault: true
  },
  updateSettingsOrThrow: vi.fn().mockResolvedValue(undefined),
  setRateLimitsFromPush: vi.fn()
}))
const refreshCapabilities = vi.fn().mockResolvedValue([])
const errorToast = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: errorToast } }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state,
    subscribe: () => () => undefined
  })
}))
vi.mock('./NewConversationAccountsColumn', () => ({
  NewConversationAccountsColumn: () => null
}))
afterEach(cleanup)
beforeEach(() => {
  state.settings.experimentalNativeChat = true
  state.settings.openAgentTabsInChatByDefault = true
  state.updateSettingsOrThrow.mockReset().mockResolvedValue(undefined)
  errorToast.mockClear()
})
const hover = {
  onPointerMove: vi.fn(),
  onPointerEnter: vi.fn(),
  onPointerLeave: vi.fn(),
  onPointerDownCapture: vi.fn(),
  onInteractOutside: vi.fn(),
  onOpenAutoFocus: vi.fn(),
  onCloseAutoFocus: vi.fn()
}
function menu(
  local = true,
  overrides: Partial<React.ComponentProps<typeof NewConversationMenu>> = {}
) {
  return render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <NewConversationMenu
          refreshCapabilities={refreshCapabilities}
          capabilities={[{ id: 'claude', label: 'Claude', status: 'usable', models: [] }]}
          rows={{ claude: [], codex: [] }}
          local={local}
          hover={hover}
          start={vi.fn()}
          companies={[{ name: 'Other' }]}
          needsCompany
          company={{ name: 'Remembered' }}
          companiesLoading={false}
          companiesError={null}
          {...overrides}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
it('tags the effective default when no provider preference was saved', () => {
  menu()
  expect(within(screen.getByRole('menuitem', { name: /Claude/ })).getByText('Default')).toBeTruthy()
})
it('shows the host account explanation for a remote target', () => {
  menu(false)
  expect(screen.getByText(/Uses the host’s default account/)).toBeTruthy()
})
it('launches a Muse model and effort directly from the provider submenu without an account', () => {
  const start = vi.fn()
  menu(true, {
    start,
    needsCompany: false,
    capabilities: [
      {
        id: 'muse',
        label: 'Muse Code',
        status: 'usable',
        models: getAgentSessionOptionCatalog('muse')!.models
      }
    ]
  })
  expect(screen.queryByRole('menuitem', { name: 'Other agents' })).toBeNull()
  fireEvent.keyDown(screen.getByRole('menuitem', { name: /Muse Code/ }), { key: 'ArrowRight' })
  fireEvent.keyDown(screen.getByRole('menuitem', { name: /Muse Spark 1.3/ }), { key: 'ArrowRight' })
  fireEvent.click(screen.getByRole('menuitem', { name: /^High/ }))
  expect(start).toHaveBeenCalledWith({
    agent: 'muse',
    account: undefined,
    model: 'muse-spark-1.3',
    effort: 'high'
  })
})
it('keeps remembered company selection reachable', () => {
  menu()
  const company = screen.getByRole('menuitem', { name: 'Company: Remembered' })
  fireEvent.keyDown(company, { key: 'ArrowRight' })
  expect(screen.getByRole('menuitem', { name: 'Other' })).toBeTruthy()
})
it('exposes density as a keyboard-selectable menu checkbox', () => {
  useSessionSidebarView.getState().setDensity('comfortable')
  menu()
  fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: 'Compact rows' }), {
    key: 'Enter'
  })
  expect(
    screen.getByRole('menuitemcheckbox', { name: 'Compact rows' }).getAttribute('aria-checked')
  ).toBe('true')
})

it('saves Terminal as the default without disabling Chat for existing sessions', async () => {
  menu()
  const checkbox = screen.getByRole('menuitemcheckbox', { name: 'Chat View' })
  expect(checkbox.getAttribute('aria-checked')).toBe('true')
  fireEvent.keyDown(checkbox, { key: 'Enter' })
  expect(state.updateSettingsOrThrow).toHaveBeenCalledWith({
    openAgentTabsInChatByDefault: false
  })
  expect(screen.getByRole('menuitem', { name: /Claude/ })).toBeTruthy()
  await waitFor(() => expect(checkbox.getAttribute('aria-disabled')).not.toBe('true'))
})

it('reads the saved Terminal preference when the menu opens', () => {
  state.settings.openAgentTabsInChatByDefault = false
  menu()
  expect(
    screen.getByRole('menuitemcheckbox', { name: 'Chat View' }).getAttribute('aria-checked')
  ).toBe('false')
})

it('enables Chat when choosing it from a profile with Chat disabled', async () => {
  state.settings.experimentalNativeChat = false
  menu()
  const checkbox = screen.getByRole('menuitemcheckbox', { name: 'Chat View' })
  expect(checkbox.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(checkbox)
  expect(state.updateSettingsOrThrow).toHaveBeenCalledWith({
    openAgentTabsInChatByDefault: true,
    experimentalNativeChat: true
  })
  await waitFor(() => expect(checkbox.getAttribute('aria-disabled')).not.toBe('true'))
})

it('waits for the saved view before allowing a provider launch', async () => {
  let finishSave!: () => void
  state.updateSettingsOrThrow.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishSave = resolve
      })
  )
  const start = vi.fn()
  menu(true, { start })
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Chat View' }))
  const provider = screen.getByRole('menuitem', { name: /Claude/ })
  expect(provider.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(provider)
  expect(start).not.toHaveBeenCalled()
  await act(async () => finishSave())
  expect(screen.getByRole('menuitem', { name: /Claude/ }).getAttribute('aria-disabled')).not.toBe(
    'true'
  )
})

it('reports a failed default-view save', async () => {
  state.updateSettingsOrThrow.mockRejectedValue(new Error('Settings unavailable'))
  menu()
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Chat View' }))
  await waitFor(() => expect(errorToast).toHaveBeenCalledWith('Could not save launch defaults.'))
})

// Why (measured live on c39b7cf81): the "Checking available agents…" state used to
// visually swallow the company picker when there was no usable worktree target — the
// picker must stay reachable regardless of the loading flag.
it('keeps the company picker visible while capabilities are still loading', () => {
  menu(true, { capabilities: [], loading: true })
  expect(screen.getByRole('menuitem', { name: 'Company: Remembered' })).toBeTruthy()
  expect(screen.getByText('Checking available agents…')).toBeTruthy()
})

it('refreshes detection and publishes usage from the same refresh action', async () => {
  const rates = { accountCapacity: { claude: [], codex: [] } }
  const refresh = vi.fn().mockResolvedValue(rates)
  Object.assign(window, { api: { rateLimits: { refresh } } })
  refreshCapabilities.mockClear()
  menu()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh' }))
  await waitFor(() => expect(state.setRateLimitsFromPush).toHaveBeenCalledWith(rates))
  expect(refreshCapabilities).toHaveBeenCalledTimes(1)
})
it('reports usage refresh errors instead of swallowing them', async () => {
  Object.assign(window, {
    api: {
      rateLimits: {
        refresh: vi.fn().mockRejectedValue(new Error('IPC failed'))
      }
    }
  })
  menu()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh' }))
  await waitFor(() =>
    expect(errorToast).toHaveBeenCalledWith('Could not refresh usage.', {
      description: 'IPC failed'
    })
  )
})

it.each([true, false])(
  'launches Gemini without account or effort controls (local: %s)',
  (local) => {
    const start = vi.fn()
    menu(local, {
      capabilities: [{ id: 'gemini', label: 'Gemini', status: 'usable', models: [] }],
      start
    })
    const item = screen.getByRole('menuitem', { name: /Gemini/ })
    expect(item.hasAttribute('aria-haspopup')).toBe(false)
    expect(screen.queryByText(/Checking usage|Uses the host’s default account|Effort/)).toBeNull()
    fireEvent.click(item)
    expect(start).toHaveBeenCalledWith({ agent: 'gemini' })
  }
)
it.each(['disabled', 'cli-missing'])('hides Gemini when %s', (status) => {
  menu(true, { capabilities: [{ id: 'gemini', label: 'Gemini', status, models: [] }] })
  expect(screen.queryByRole('menuitem', { name: /Gemini/ })).toBeNull()
})

const allProviders = (kimiStatus = 'usable') =>
  (
    [
      ['gemini', 'Gemini'],
      ['omp', 'OMP'],
      ['grok', 'Grok'],
      ['kimi', 'Kimi'],
      ['codex', 'Codex'],
      ['claude', 'Claude']
    ] as const
  ).map(([id, label]) => ({
    id,
    label,
    status: id === 'kimi' ? kimiStatus : 'usable',
    models: []
  }))
const providerRows = () =>
  screen
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '')
    .map((text) =>
      ['Claude', 'Codex', 'Kimi', 'Grok', 'OMP', 'Gemini'].find((l) => text.includes(l))
    )
    .filter(Boolean)
it('orders providers Claude, Codex, Kimi, Grok, OMP, Gemini', () => {
  menu(true, { capabilities: allProviders() })
  expect(providerRows()).toEqual(['Claude', 'Codex', 'Kimi', 'Grok', 'OMP', 'Gemini'])
})
it('launches Kimi with its CLI default and no account submenu', () => {
  const start = vi.fn()
  menu(true, { capabilities: allProviders(), start })
  const item = screen.getByRole('menuitem', { name: /Kimi/ })
  expect(item.hasAttribute('aria-haspopup')).toBe(false)
  fireEvent.click(item)
  expect(start).toHaveBeenCalledWith({ agent: 'kimi' })
})
it('hides Kimi when its login is signed out', () => {
  menu(true, { capabilities: allProviders('logged-out') })
  expect(providerRows()).toEqual(['Claude', 'Codex', 'Grok', 'OMP', 'Gemini'])
})
it('shows launcher context at the top level, with its count, only while some is attached', async () => {
  menu()
  expect(screen.queryByRole('menuitem', { name: /Session context/ })).toBeNull()
  cleanup()

  const key = launchSessionContextKey(null)
  await setSessionContext(key, [
    { id: 'instructions:1', kind: 'instructions', title: 'Once', content: 'Once' }
  ])
  try {
    menu()
    const row = screen.getByRole('menuitem', { name: /Session context/ })
    expect(row.textContent).toContain('1')
  } finally {
    await setSessionContext(key, [])
  }
})
