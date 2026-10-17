// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeTerminalAccessiblePaneToken } from '../../../../shared/terminal-accessible-pane-token'
import { installTerminalAccessibleIdentity } from './terminal-accessible-identity'

const paneKey = 'tab-a:11111111-1111-4111-8111-111111111111'

afterEach(() => {
  document.body.replaceChildren()
})

function terminal(options: { focuses?: boolean; label?: string } = {}) {
  const textarea = document.createElement('textarea')
  if (options.label !== undefined) {
    textarea.setAttribute('aria-label', options.label)
  }
  document.body.append(textarea)
  const input = vi.fn()
  return {
    textarea,
    input,
    focus: () => {
      if (options.focuses !== false) {
        textarea.focus()
      }
    }
  }
}

function dispatch(
  textarea: HTMLTextAreaElement,
  detail: { paneKey: string; value?: string; result?: unknown }
): { claimed: boolean; detail: typeof detail } {
  const event = new CustomEvent('omni-terminal-accessible-action', { detail, cancelable: true })
  textarea.dispatchEvent(event)
  return { claimed: event.defaultPrevented, detail }
}

describe('terminal accessible identity', () => {
  it('stamps the pane identity even when xterm has not labelled its input', () => {
    const host = terminal()

    const binding = installTerminalAccessibleIdentity(host, paneKey)

    expect(host.textarea.getAttribute('aria-label')).toBe(
      `Terminal input (omni-terminal=${encodeTerminalAccessiblePaneToken(paneKey)})`
    )
    expect(host.textarea.dataset.omniTerminalPane).toBe(paneKey)
    binding.dispose()
  })

  it('appends the identity to the label xterm supplied', () => {
    const host = terminal({ label: 'Terminal input' })

    const binding = installTerminalAccessibleIdentity(host, paneKey)

    expect(host.textarea.getAttribute('aria-label')).toBe(
      `Terminal input (omni-terminal=${encodeTerminalAccessiblePaneToken(paneKey)})`
    )
    binding.dispose()
  })

  it('delivers text for the raw pane key and the encoded token from the name', () => {
    const host = terminal({ label: 'Terminal input' })
    const binding = installTerminalAccessibleIdentity(host, paneKey)

    const raw = dispatch(host.textarea, { paneKey, value: 'hello' })
    const encoded = dispatch(host.textarea, {
      paneKey: encodeTerminalAccessiblePaneToken(paneKey),
      value: 'again'
    })

    expect(raw.claimed).toBe(true)
    expect(encoded.claimed).toBe(true)
    expect(host.input.mock.calls).toEqual([
      ['hello', true],
      ['again', true]
    ])
    expect(raw.detail.result).toEqual({ focused: true, applied: true })
    binding.dispose()
  })

  it('reports a refused focus instead of dropping the text silently', () => {
    const host = terminal({ label: 'Terminal input', focuses: false })
    const binding = installTerminalAccessibleIdentity(host, paneKey)

    const delivery = dispatch(host.textarea, { paneKey, value: 'hello' })

    expect(delivery.claimed).toBe(true)
    expect(delivery.detail.result).toEqual({ focused: false, applied: false })
    expect(host.input).not.toHaveBeenCalled()
    binding.dispose()
  })

  it('ignores a request addressed to another pane', () => {
    const host = terminal({ label: 'Terminal input' })
    const binding = installTerminalAccessibleIdentity(host, paneKey)

    const delivery = dispatch(host.textarea, {
      paneKey: 'tab-b:22222222-2222-4222-8222-222222222222',
      value: 'hello'
    })

    expect(delivery.claimed).toBe(false)
    expect(delivery.detail.result).toBeUndefined()
    expect(host.input).not.toHaveBeenCalled()
    binding.dispose()
  })
})
