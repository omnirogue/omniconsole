// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

import { DeliverableCheckSetting } from './DeliverableCheckSetting'

const settings = (deliverableVerifier?: GlobalSettings['deliverableVerifier']) =>
  ({ deliverableVerifier }) as GlobalSettings

describe('DeliverableCheckSetting', () => {
  afterEach(cleanup)

  it('defaults to Watch only and explains that nothing is sent', () => {
    render(<DeliverableCheckSetting settings={settings()} updateSettings={vi.fn()} />)
    expect(screen.getByRole('radio', { name: 'Watch only' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(screen.getByText(/Nothing is sent\./)).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Times to ask per request' })).toBeNull()
  })

  it('turns repairs on and offers 1 to 3 asks', () => {
    const updateSettings = vi.fn()
    render(<DeliverableCheckSetting settings={settings()} updateSettings={updateSettings} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Check and ask to finish' }))
    expect(updateSettings).toHaveBeenCalledWith({
      deliverableVerifier: { mode: 'on', maxRepairs: 2 }
    })
    cleanup()
    render(
      <DeliverableCheckSetting
        settings={settings({ mode: 'on', maxRepairs: 2 })}
        updateSettings={updateSettings}
      />
    )
    expect(screen.getByText(/up to 2 times per request/)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: '3' }))
    expect(updateSettings).toHaveBeenLastCalledWith({
      deliverableVerifier: { mode: 'on', maxRepairs: 3 }
    })
  })
})
