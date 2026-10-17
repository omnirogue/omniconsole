// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CustomerServiceLaunchApi } from '../../../../shared/customer-service-launch'

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  create: vi.fn(),
  folder: vi.fn(),
  toast: vi.fn(),
  state: {
    hydrationSucceeded: true,
    persistedUIReady: true,
    settings: { defaultTuiAgent: 'codex' },
    scope: 'person-a'
  }
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mocks.state), {
    getState: () => mocks.state
  })
}))
vi.mock('@/lib/console-account-scope', () => ({
  selectConsoleAccountScope: (state: { scope: string }) => state.scope
}))
vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: () => ({ usable: [{ id: 'codex' }] })
}))
vi.mock('@/lib/agent-catalog', () => ({ getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }] }))
vi.mock('@/lib/start-company-session', () => ({
  startCompanySession: mocks.start,
  createCompanySessionFolder: mocks.create,
  resolveCompanySessionFolder: mocks.folder
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, text: string) => text }))
vi.mock('sonner', () => ({ toast: { success: mocks.toast } }))
import { CustomerServiceLaunchDialog } from './CustomerServiceLaunchDialog'

const launch = {
  launch_id: `csl_${'a'.repeat(32)}`,
  status: 'prepared' as const,
  company: { slug: 'omnirogue', name: 'OmniRogue' },
  brief: 'Issue 1 and issue 2: review the customer history.',
  ticket_ids: [1, 2],
  claim_id: null,
  session_ledger_id: null
}
let api: CustomerServiceLaunchApi
beforeEach(() => {
  mocks.state.scope = 'person-a'
  mocks.folder.mockResolvedValue('/Users/current/Work/OmniRogue/Customer Service')
  mocks.create.mockResolvedValue({ ok: true })
  mocks.start.mockImplementation(async (args) => {
    args.onSessionCreated('tab-new')
    return { ok: true, workspaceId: 'workspace', tabId: 'tab-new' }
  })
  api = {
    onOpen: vi.fn(() => () => {}),
    consumePending: vi.fn(async () => launch.launch_id),
    preview: vi.fn<CustomerServiceLaunchApi['preview']>(async () => ({
      ok: true,
      data: { launch, previewKey: 'preview', localState: 'ready' }
    })),
    begin: vi.fn<CustomerServiceLaunchApi['begin']>(async () => ({
      ok: true,
      data: { ...launch, status: 'claimed', claim_id: 'claim' }
    })),
    receipt: vi.fn<CustomerServiceLaunchApi['receipt']>(async () => ({
      ok: true,
      data: { ...launch, status: 'launched', session_ledger_id: 'ledger' }
    }))
  }
  Object.assign(window, { api: { customerServiceLaunch: api } })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('shows the fetched issue brief and launches one grouped local session only after native confirmation', async () => {
  render(<CustomerServiceLaunchDialog />)
  expect(await screen.findByText(launch.brief)).toBeTruthy()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(api.begin).not.toHaveBeenCalled()
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Start on this computer' }).hasAttribute('disabled')
    ).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Start on this computer' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1))
  expect(mocks.start).toHaveBeenCalledWith(
    expect.objectContaining({
      company: launch.company,
      domain: { name: 'Customer Service' },
      note: launch.brief,
      agent: 'codex',
      expectedAccountScope: 'person-a'
    })
  )
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1))
  expect(api.receipt).toHaveBeenCalledWith({ previewKey: 'preview', tabId: 'tab-new' })
})

it('does not launch when the signed-in desktop cannot read the owner-scoped request', async () => {
  vi.mocked(api.preview).mockResolvedValue({
    ok: false,
    error: { code: 'forbidden', message: 'Sign in as the person who selected these issues.' }
  })
  render(<CustomerServiceLaunchDialog />)
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Start on this computer' })).toBeNull()
  expect(api.begin).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('retries a pending ledger receipt without creating another session', async () => {
  vi.mocked(api.receipt).mockResolvedValue({
    ok: false,
    error: { code: 'receipt_pending', message: 'Waiting for the ledger.' }
  })
  render(<CustomerServiceLaunchDialog />)
  await screen.findByText(launch.brief)
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Start on this computer' }).hasAttribute('disabled')
    ).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Start on this computer' }))
  await screen.findByText('Waiting for the ledger.')
  expect(mocks.toast).not.toHaveBeenCalled()
  vi.mocked(api.receipt).mockResolvedValue({
    ok: true,
    data: { ...launch, status: 'launched', session_ledger_id: 'ledger' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Record session receipt' }))
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1))
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(api.begin).toHaveBeenCalledTimes(1)
})
