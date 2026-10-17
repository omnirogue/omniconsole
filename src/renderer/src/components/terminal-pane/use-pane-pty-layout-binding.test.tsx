// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePanePtyLayoutBinding } from './use-pane-pty-layout-binding'

function mountedChat() {
  const savedBindings = new Map([
    [1, 'pty-original'],
    [2, 'pty-sibling']
  ])
  const liveBindings = new Map<number, string>()
  const persistChangedLayout = vi.fn()
  const writeBinding = (paneId: number, ptyId: string | null): void => {
    if (savedBindings.get(paneId) === ptyId) {
      return
    }
    if (ptyId) {
      savedBindings.set(paneId, ptyId)
    } else {
      savedBindings.delete(paneId)
    }
    persistChangedLayout()
  }
  let bind!: (paneId: number, ptyId: string | null) => void
  function Chat() {
    const [, setPaneLayoutRevision] = useState(0)
    const publishBinding = usePanePtyLayoutBinding(writeBinding, setPaneLayoutRevision)
    bind = (paneId, ptyId) => {
      if (ptyId) {
        liveBindings.set(paneId, ptyId)
      } else {
        liveBindings.delete(paneId)
      }
      publishBinding(paneId, ptyId)
    }
    const ptyId = liveBindings.get(1) ?? null
    return (
      <textarea
        aria-label="Chat draft"
        disabled={!ptyId}
        data-pty-id={ptyId}
        defaultValue="keep the draft"
      />
    )
  }
  const view = render(<Chat />)
  const composer = view.getByRole('textbox', { name: 'Chat draft' }) as HTMLTextAreaElement
  return {
    ...view,
    composer,
    persistChangedLayout,
    bind: (id: number, pty: string | null) => bind(id, pty)
  }
}

describe('live pane binding publication', () => {
  afterEach(cleanup)

  it('enables a waiting Chat after the same saved PTY reattaches without a layout change', async () => {
    const { composer, bind, persistChangedLayout, getByRole } = mountedChat()
    expect(composer.disabled).toBe(true)

    await act(async () => {
      await Promise.resolve()
      bind(1, 'pty-original')
    })

    expect(persistChangedLayout).not.toHaveBeenCalled()
    expect(composer.disabled).toBe(false)
    expect(composer.dataset.ptyId).toBe('pty-original')
    expect(getByRole('textbox', { name: 'Chat draft' })).toBe(composer)
    expect(composer.value).toBe('keep the draft')
  })

  it('keeps an unattached Chat disabled when only its split sibling reattaches', () => {
    const { composer, bind, persistChangedLayout } = mountedChat()
    act(() => bind(2, 'pty-sibling'))
    expect(persistChangedLayout).not.toHaveBeenCalled()
    expect(composer.disabled).toBe(true)
    expect(composer.dataset.ptyId).toBeUndefined()
  })

  it('publishes detach and replacement without remounting the draft', () => {
    const { composer, bind, getByRole } = mountedChat()
    act(() => bind(1, 'pty-original'))
    act(() => bind(1, null))
    expect(composer.disabled).toBe(true)
    act(() => bind(1, 'pty-replacement'))
    expect(composer.disabled).toBe(false)
    expect(composer.dataset.ptyId).toBe('pty-replacement')
    expect(getByRole('textbox', { name: 'Chat draft' })).toBe(composer)
    expect(composer.value).toBe('keep the draft')
  })
})
