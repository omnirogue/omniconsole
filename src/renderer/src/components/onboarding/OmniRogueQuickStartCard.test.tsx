// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OmniRogueAccountState } from '../../../../shared/omnirogue-account'
import {
  OmniRogueQuickStartCard,
  type OmniRogueQuickStartCardProps
} from './OmniRogueQuickStartCard'
import {
  DEFAULT_OMNIROGUE_QUICK_START_LABELS as copy,
  getOmniRogueQuickStartState,
  resolveOmniRogueQuickStartLabels,
  type OmniRogueQuickStartLabels
} from './omnirogue-quickstart-helpers'

afterEach(cleanup)

function makeProps(
  overrides: Partial<OmniRogueQuickStartCardProps> = {}
): OmniRogueQuickStartCardProps {
  return {
    accountState: { state: 'disconnected' },
    onConnectAccount: vi.fn(),
    onOpenSignup: vi.fn(),
    onUseOwnLogin: vi.fn(),
    onContinue: vi.fn(),
    ...overrides
  }
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('getOmniRogueQuickStartState', () => {
  it.each(['connected', 'linked'] as const)('recognizes %s accounts', (state) => {
    const result = getOmniRogueQuickStartState({
      state,
      email: ' user@example.com ',
      orgName: ' Team ',
      lastError: 'stale'
    })
    expect(result).toEqual({
      isConnected: true,
      isConnecting: false,
      accountSummary: 'user@example.com · Team',
      errorMessage: null
    })
  })

  it.each(['connecting', 'linking'] as const)(
    'recognizes %s without exposing stale identity',
    (state) => {
      expect(getOmniRogueQuickStartState({ state, email: 'old@example.com' })).toMatchObject({
        isConnected: false,
        isConnecting: true,
        accountSummary: null,
        errorMessage: null
      })
    }
  )

  it.each(['unlinked', 'disconnected'] as const)(
    'does not trust stale connected flags for %s',
    (state) => {
      expect(getOmniRogueQuickStartState({ state, connected: true }).isConnected).toBe(false)
    }
  )

  it('falls back to a display name and omits blank account details', () => {
    expect(
      getOmniRogueQuickStartState({
        state: 'linked',
        email: ' ',
        displayName: ' Sal ',
        orgName: ' '
      }).accountSummary
    ).toBe('Sal')
    expect(getOmniRogueQuickStartState({ state: 'linked' }).accountSummary).toBeNull()
  })

  it('uses supplied error details or the caller’s fallback copy', () => {
    const labels = resolveOmniRogueQuickStartLabels({
      connectionError: 'Connection failed'
    })
    expect(
      getOmniRogueQuickStartState({
        state: 'error',
        lastError: ' Try again later '
      }).errorMessage
    ).toBe('Try again later')
    expect(
      getOmniRogueQuickStartState({ state: 'error', lastError: ' ' }, labels).errorMessage
    ).toBe(labels.connectionError)
  })

  it('preserves defaults for omitted or undefined overrides without mutating them', () => {
    const labels = resolveOmniRogueQuickStartLabels({
      title: 'Welcome',
      connect: undefined
    })
    expect(labels.title).toBe('Welcome')
    expect(labels.connect).toBe(copy.connect)
    expect(copy.title).not.toBe(labels.title)
  })
})

describe('OmniRogueQuickStartCard', () => {
  it('renders an accessible card without starting any actions', () => {
    const props = makeProps()
    render(<OmniRogueQuickStartCard {...props} />)
    expect(screen.getByRole('region', { name: copy.title }).getAttribute('aria-describedby')).toBe(
      screen.getByText(copy.description).id
    )
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(copy.title)
    expect(screen.getByRole('status').textContent).toContain(copy.disconnected)
    expect(button(copy.connect).disabled).toBe(false)
    expect(button(copy.signup).type).toBe('button')
    expect(props.onConnectAccount).not.toHaveBeenCalled()
    expect(props.onOpenSignup).not.toHaveBeenCalled()
    expect(props.onUseOwnLogin).not.toHaveBeenCalled()
    expect(props.onContinue).not.toHaveBeenCalled()
  })

  it('connects once while pending and waits for account state before offering continuation', async () => {
    const request = deferred()
    const props = makeProps({ onConnectAccount: vi.fn(() => request.promise) })
    const { rerender } = render(<OmniRogueQuickStartCard {...props} />)
    const connect = button(copy.connect)
    act(() => {
      connect.click()
      connect.click()
    })
    expect(props.onConnectAccount).toHaveBeenCalledTimes(1)
    expect(button(copy.waiting).disabled).toBe(true)
    expect(button(copy.signup).disabled).toBe(true)
    expect(button(copy.ownLogin).disabled).toBe(true)
    await act(async () => {
      request.resolve()
    })
    expect(button(copy.connect).disabled).toBe(false)
    expect(screen.queryByText(copy.connected)).toBeNull()
    rerender(<OmniRogueQuickStartCard {...props} accountState={{ state: 'connected' }} />)
    fireEvent.click(button(copy.continue))
    await waitFor(() => expect(props.onContinue).toHaveBeenCalledTimes(1))
  })

  it('opens signup only when requested', async () => {
    const props = makeProps()
    render(<OmniRogueQuickStartCard {...props} />)
    fireEvent.click(button(copy.signup))
    await waitFor(() => expect(props.onOpenSignup).toHaveBeenCalledTimes(1))
    expect(props.onConnectAccount).not.toHaveBeenCalled()
  })

  it.each(['connected', 'linked'] as const)('offers continuation for %s accounts', (state) => {
    render(
      <OmniRogueQuickStartCard
        {...makeProps({
          accountState: { state, email: 'user@example.com', orgName: 'Team' }
        })}
      />
    )
    expect(screen.getByRole('status').textContent).toContain(copy.connected)
    expect(screen.getByText('user@example.com · Team')).toBeTruthy()
    expect(button(copy.continue).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: copy.connect })).toBeNull()
    expect(screen.queryByRole('button', { name: copy.signup })).toBeNull()
  })

  it.each(['connecting', 'linking'] as const)(
    'allows an own-login escape while %s',
    async (state) => {
      const props = makeProps({ accountState: { state } })
      render(<OmniRogueQuickStartCard {...props} />)
      expect(button(copy.waiting).disabled).toBe(true)
      expect(button(copy.signup).disabled).toBe(true)
      expect(button(copy.ownLogin).disabled).toBe(false)
      fireEvent.click(button(copy.ownLogin))
      await waitFor(() => expect(props.onUseOwnLogin).toHaveBeenCalledTimes(1))
      expect(props.onConnectAccount).not.toHaveBeenCalled()
    }
  )

  it('allows own-login continuation even when browser linking remains pending', async () => {
    const props = makeProps({
      accountState: { state: 'linking' },
      selectedBilling: 'own-login'
    })
    render(<OmniRogueQuickStartCard {...props} />)
    expect(screen.getByRole('status').textContent).toContain(copy.ownLoginSelected)
    expect(button(copy.ownLogin).getAttribute('aria-pressed')).toBe('true')
    expect(button(copy.continue).disabled).toBe(false)
    fireEvent.click(button(copy.continue))
    await waitFor(() => expect(props.onContinue).toHaveBeenCalledTimes(1))
    expect(props.onConnectAccount).not.toHaveBeenCalled()
  })

  it('disables every action while the caller is busy', () => {
    const props = makeProps({ isBusy: true })
    render(<OmniRogueQuickStartCard {...props} />)
    for (const control of screen.getAllByRole('button')) {
      expect((control as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(control)
    }
    expect(props.onConnectAccount).not.toHaveBeenCalled()
    expect(props.onOpenSignup).not.toHaveBeenCalled()
    expect(props.onUseOwnLogin).not.toHaveBeenCalled()
    expect(screen.getByRole('region').getAttribute('aria-busy')).toBe('true')
  })

  it('handles rejected actions and clears the error when retrying', async () => {
    const request = deferred()
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('internal'))
      .mockReturnValueOnce(request.promise)
    render(<OmniRogueQuickStartCard {...makeProps({ onConnectAccount: connect })} />)
    fireEvent.click(button(copy.connect))
    expect((await screen.findByRole('alert')).textContent).toBe(copy.actionError)
    fireEvent.click(button(copy.connect))
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => {
      request.resolve()
    })
    expect(connect).toHaveBeenCalledTimes(2)
    expect(button(copy.connect).disabled).toBe(false)
  })

  it('handles synchronous callback failures', async () => {
    const props = makeProps({
      onOpenSignup: () => {
        throw new Error('internal')
      }
    })
    render(<OmniRogueQuickStartCard {...props} />)
    fireEvent.click(button(copy.signup))
    expect((await screen.findByRole('alert')).textContent).toBe(copy.actionError)
    expect(button(copy.signup).disabled).toBe(false)
  })

  it('clears an action error when account state recovers', async () => {
    const props = makeProps({
      onConnectAccount: vi.fn().mockRejectedValue(new Error('internal'))
    })
    const { rerender } = render(<OmniRogueQuickStartCard {...props} />)
    fireEvent.click(button(copy.connect))
    await screen.findByRole('alert')
    rerender(<OmniRogueQuickStartCard {...props} accountState={{ state: 'linked' }} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button(copy.continue).disabled).toBe(false)
  })

  it('uses supplied labels for every rendered state and failure', async () => {
    const labels = Object.fromEntries(
      Object.keys(copy).map((key) => [key, `translated:${key}`])
    ) as OmniRogueQuickStartLabels
    const props = makeProps({
      labels,
      onConnectAccount: vi.fn().mockRejectedValue(new Error('internal'))
    })
    const { rerender } = render(<OmniRogueQuickStartCard {...props} />)
    expect(screen.getByRole('heading').textContent).toBe(labels.title)
    expect(screen.getByText(labels.description)).toBeTruthy()
    expect(screen.getByText(labels.ownLoginDescription)).toBeTruthy()
    expect(button(labels.signup)).toBeTruthy()
    expect(button(labels.ownLogin)).toBeTruthy()
    fireEvent.click(button(labels.connect))
    expect((await screen.findByRole('alert')).textContent).toBe(labels.actionError)
    const states: OmniRogueAccountState['state'][] = ['error', 'linking', 'linked']
    for (const state of states) {
      rerender(<OmniRogueQuickStartCard {...props} accountState={{ state }} />)
      expect(screen.queryByText(copy.title)).toBeNull()
      if (state === 'error') {
        expect(screen.getByRole('alert').textContent).toBe(labels.connectionError)
      }
      if (state === 'linking') {
        expect(button(labels.waiting).disabled).toBe(true)
      }
      if (state === 'linked') {
        expect(button(labels.continue).disabled).toBe(false)
        expect(screen.getByRole('status').textContent).toContain(labels.connected)
      }
    }
  })

  it('settles a rejected callback safely after unmounting', async () => {
    const request = deferred()
    const props = makeProps({ onConnectAccount: vi.fn(() => request.promise) })
    const { unmount } = render(<OmniRogueQuickStartCard {...props} />)
    fireEvent.click(button(copy.connect))
    unmount()
    await act(async () => {
      request.reject(new Error('late failure'))
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
