// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCompaniesWindowApi } from './companies-test-fixtures'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, text: string, options?: Record<string, unknown>) =>
    options
      ? text.replace(/{{(\w+)}}/g, (_match, name: string) => String(options[name] ?? ''))
      : text,
  i18n: { language: 'en' }
}))
vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: () => ({
    usable: [{ id: 'codex', models: [{ id: 'gpt-6-astra' }] }],
    refresh: async () => [{ id: 'codex', status: 'usable', models: [{ id: 'gpt-6-astra' }] }]
  })
}))
const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (message: string) => toastError(message) } }))
const openSettingsTarget = vi.fn()
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({
      settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] },
      openSettingsTarget
    })
}))
const startCompanySession = vi.fn()
const createCompanySessionFolder = vi.fn()
vi.mock('@/lib/start-company-session', () => ({
  startCompanySession: (args: unknown) => startCompanySession(args),
  createCompanySessionFolder: (path: string) => createCompanySessionFolder(path),
  resolveCompanySessionFolder: () => Promise.resolve('/Users/maintainer/Work/OmniRogue/Advertising')
}))

import { CompanyStartSession } from './CompanyStartSession'

const company = { slug: 'omnirogue', name: 'OmniRogue' }
const domain = { id: 'dom_ads', name: 'Advertising' }

function openPopover(): void {
  render(<CompanyStartSession company={company} domain={domain} />)
  fireEvent.click(screen.getByRole('button', { name: /Start Work/ }))
}

beforeEach(() => {
  installCompaniesWindowApi()
  toastError.mockReset()
  openSettingsTarget.mockReset()
  startCompanySession.mockReset()
  createCompanySessionFolder.mockReset()
  startCompanySession.mockResolvedValue({ ok: true, workspaceId: 'workspace-1' })
})
afterEach(cleanup)

describe('Start Work', () => {
  it('shows the resolved folder and the agent the settings default to', async () => {
    openPopover()

    expect(
      await screen.findByText('/Users/maintainer/Work/OmniRogue/Advertising')
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Agent').textContent).toContain('Codex')
  })

  it('starts the session for the chosen department with the typed first message', async () => {
    openPopover()
    fireEvent.change(await screen.findByLabelText('First message (optional)'), {
      target: { value: 'Check yesterday’s spend' }
    })

    fireEvent.click(screen.getAllByRole('button', { name: 'Start Work' })[1])

    await waitFor(() =>
      expect(startCompanySession).toHaveBeenCalledWith({
        company,
        domain,
        agent: 'codex',
        note: 'Check yesterday’s spend',
        launchPreferences: { model: 'gpt-6-astra' },
        viewModePreference: 'chat'
      })
    )
  })

  it('offers to create the folder when it is missing, then starts', async () => {
    startCompanySession.mockResolvedValueOnce({
      ok: false,
      reason: 'folder-missing',
      path: '/Users/maintainer/Work/OmniRogue/Advertising'
    })
    createCompanySessionFolder.mockResolvedValue({ ok: true })
    openPopover()

    fireEvent.click((await screen.findAllByRole('button', { name: 'Start Work' }))[1])

    const create = await screen.findByRole('button', {
      name: 'Create /Users/maintainer/Work/OmniRogue/Advertising'
    })
    fireEvent.click(create)

    await waitFor(() =>
      expect(createCompanySessionFolder).toHaveBeenCalledWith(
        '/Users/maintainer/Work/OmniRogue/Advertising'
      )
    )
    await waitFor(() => expect(startCompanySession).toHaveBeenCalledTimes(2))
  })

  it('says why nothing happened rather than leaving a dead button', async () => {
    startCompanySession.mockResolvedValue({
      ok: false,
      reason: 'failed',
      message: 'The session folder could not be opened, so no agent was started.'
    })
    openPopover()

    fireEvent.click((await screen.findAllByRole('button', { name: 'Start Work' }))[1])

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'The session folder could not be opened, so no agent was started.'
      )
    )
  })

  it('sends the reader to the settings that own the folder', async () => {
    openPopover()

    fireEvent.click(await screen.findByRole('button', { name: 'Change in Settings' }))

    expect(openSettingsTarget).toHaveBeenCalledWith({ pane: 'backoffice', repoId: null })
  })
})
