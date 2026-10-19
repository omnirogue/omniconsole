// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../shared/constants'

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

import { BackofficeSettingsPane } from './BackofficeSettingsPane'

function productionField(): HTMLInputElement {
  return screen.getByLabelText('Production URL') as HTMLInputElement
}

describe('BackofficeSettingsPane', () => {
  beforeEach(() => {
    mocks.updateSettings.mockClear()
    mocks.settings = getDefaultSettings('/tmp')
  })

  afterEach(cleanup)

  it('shows Production as the active environment for a fresh profile', () => {
    render(<BackofficeSettingsPane />)
    expect(screen.getByRole('button', { name: 'Production' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Local' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('pre-fills the production URL with the live console when nothing is stored', () => {
    mocks.settings = { ...getDefaultSettings('/tmp'), backofficeProductionUrl: '' }
    render(<BackofficeSettingsPane />)
    expect(productionField()).toHaveValue('https://console.example.com')
  })

  it('shows a stored production URL instead of the default', () => {
    mocks.settings = {
      ...getDefaultSettings('/tmp'),
      backofficeProductionUrl: 'https://console.example.com'
    }
    render(<BackofficeSettingsPane />)
    expect(productionField()).toHaveValue('https://console.example.com')
  })

  it('keeps a profile that explicitly chose local on Local', () => {
    mocks.settings = { ...getDefaultSettings('/tmp'), backofficeEnv: 'local' }
    render(<BackofficeSettingsPane />)
    expect(screen.getByRole('button', { name: 'Local' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Local URL')).toHaveValue('http://127.0.0.1:4477')
  })
})
