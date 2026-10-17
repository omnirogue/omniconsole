// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { companiesApiMock, installCompaniesWindowApi } from '../companies/companies-test-fixtures'

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(async () => undefined),
  settings: null as GlobalSettings | null
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: mocks.settings, updateSettings: mocks.updateSettings })
}))

import { CompanyFoldersSettingsPane } from './CompanyFoldersSettingsPane'

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement
}

describe('CompanyFoldersSettingsPane', () => {
  beforeEach(() => {
    installCompaniesWindowApi()
    mocks.updateSettings.mockClear()
    mocks.settings = getDefaultSettings('/tmp')
  })

  afterEach(cleanup)

  it('offers every company from the estate with its resolved default folder', async () => {
    render(<CompanyFoldersSettingsPane />)

    expect(field('Work root').value).toBe('~/Work')
    await waitFor(() =>
      expect(field('OmniRogue').placeholder).toBe('/Users/maintainer/Work/OmniRogue')
    )
  })

  it('saves a valid override and refuses a relative one', async () => {
    render(<CompanyFoldersSettingsPane />)
    const input = await screen.findByLabelText('OmniRogue')

    fireEvent.change(input, { target: { value: 'work/omnirogue' } })
    fireEvent.blur(input)

    expect(
      screen.getByText('Use an absolute path or one starting with ~/ — nothing was saved.')
    ).toBeInTheDocument()
    expect(mocks.updateSettings).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '~/Code/omnirogue' } })
    fireEvent.blur(input)

    expect(mocks.updateSettings).toHaveBeenCalledWith({
      companyFolders: { omnirogue: '~/Code/omnirogue' }
    })
  })

  it('refuses an invalid work root and keeps the saved one', () => {
    render(<CompanyFoldersSettingsPane />)
    const root = field('Work root')

    fireEvent.change(root, { target: { value: 'Work' } })
    fireEvent.blur(root)

    expect(
      screen.getByText('Use an absolute path or one starting with ~/ — nothing was saved.')
    ).toBeInTheDocument()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('resets a company back to the convention', async () => {
    mocks.settings = {
      ...getDefaultSettings('/tmp'),
      companyFolders: { omnirogue: '~/Code/omnirogue' }
    }
    render(<CompanyFoldersSettingsPane />)
    await screen.findByLabelText('OmniRogue')

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))

    expect(mocks.updateSettings).toHaveBeenCalledWith({ companyFolders: {} })
  })

  it('still lists a configured company when the estate read fails', async () => {
    companiesApiMock.org.mockRejectedValue(new Error('offline'))
    mocks.settings = {
      ...getDefaultSettings('/tmp'),
      companyFolders: { apexlabs: '~/Work/ApexLabs' }
    }
    render(<CompanyFoldersSettingsPane />)

    expect(await screen.findByLabelText('apexlabs')).toBeInTheDocument()
  })
})
