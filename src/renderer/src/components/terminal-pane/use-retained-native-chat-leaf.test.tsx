// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatSendHandle } from '../native-chat/native-chat-send-contract'
import { useNativeChatSendLifecycle } from '../native-chat/use-native-chat-send-lifecycle'
import { useRetainedNativeChatLeaf } from './use-retained-native-chat-leaf'

function Composer({
  tabId,
  ptyId,
  send
}: {
  tabId: string
  ptyId: string
  send: NativeChatSendHandle
}) {
  const { trackPendingSend } = useNativeChatSendLifecycle(tabId, ptyId)
  useLayoutEffect(() => trackPendingSend(send), [send, trackPendingSend])
  return <textarea aria-label="Chat draft" defaultValue="keep this draft" />
}

function Pane({
  tabId = 'tab-1',
  chatLeafId,
  chat,
  activeLeafId = 'leaf-1',
  panes,
  send
}: {
  tabId?: string
  chatLeafId: string | null
  chat: boolean
  activeLeafId?: string
  panes: Record<string, string>
  send: NativeChatSendHandle
}) {
  const leaf = useRetainedNativeChatLeaf(tabId, chat, chatLeafId, activeLeafId)
  const pty = leaf ? panes[leaf] : null
  return pty ? (
    <div key={leaf} style={chat ? undefined : { display: 'none' }}>
      <Composer tabId={tabId} ptyId={pty} send={send} />
    </div>
  ) : null
}

function delayedSend() {
  const submit = vi.fn()
  let finish!: () => void
  const settled = new Promise<void>((resolve) => {
    finish = resolve
  })
  const timer = setTimeout(() => {
    submit()
    finish()
  }, 500)
  const cancel = vi.fn(() => {
    clearTimeout(timer)
    finish()
  })
  return { cancel, settled, settleAfterMs: 500, submit }
}

describe('retained Chat pane send ownership', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('finishes exactly one pending Enter and retains the composer across Terminal toggles', async () => {
    vi.useFakeTimers()
    const send = delayedSend()
    const panes = { 'leaf-1': 'pty-1' }
    const { rerender, getByRole } = render(
      <Pane chat chatLeafId="leaf-1" panes={panes} send={send} />
    )
    const composer = getByRole('textbox', { name: 'Chat draft' })

    rerender(<Pane chat={false} chatLeafId={null} panes={panes} send={send} />)
    expect(send.cancel).not.toHaveBeenCalled()
    for (let index = 0; index < 3; index++) {
      rerender(<Pane chat chatLeafId={null} panes={panes} send={send} />)
      expect(getByRole('textbox', { name: 'Chat draft' })).toBe(composer)
      rerender(<Pane chat chatLeafId="leaf-1" panes={panes} send={send} />)
      rerender(<Pane chat={false} chatLeafId={null} panes={panes} send={send} />)
    }
    expect(send.cancel).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(500)
      await send.settled
    })
    rerender(<Pane chat chatLeafId="leaf-1" panes={panes} send={send} />)

    expect(send.submit).toHaveBeenCalledOnce()
    expect(getByRole('textbox', { name: 'Chat draft' })).toBe(composer)
    expect((composer as HTMLTextAreaElement).value).toBe('keep this draft')
  })

  it('does not reveal the old composer when Chat selects another active split', () => {
    vi.useFakeTimers()
    const send = delayedSend()
    const panes = { 'leaf-1': 'pty-1', 'leaf-2': 'pty-2' }
    const { rerender, queryByRole } = render(
      <Pane chat chatLeafId="leaf-1" panes={panes} send={send} />
    )
    rerender(<Pane chat={false} chatLeafId={null} panes={panes} send={send} />)
    rerender(<Pane chat chatLeafId={null} activeLeafId="leaf-2" panes={panes} send={send} />)
    expect(queryByRole('textbox', { name: 'Chat draft' })).toBeNull()
    expect(send.cancel).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(500))
    expect(send.submit).not.toHaveBeenCalled()
  })

  it.each(['close', 'rebind', 'other-tab'])('still cancels old writes on %s', (change) => {
    vi.useFakeTimers()
    const send = delayedSend()
    const { rerender } = render(
      <Pane chat chatLeafId="leaf-1" panes={{ 'leaf-1': 'pty-1' }} send={send} />
    )
    rerender(
      <Pane
        tabId={change === 'other-tab' ? 'tab-2' : 'tab-1'}
        chat={false}
        chatLeafId={null}
        panes={change === 'close' ? {} : { 'leaf-1': change === 'rebind' ? 'pty-2' : 'pty-1' }}
        send={send}
      />
    )
    expect(send.cancel).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(500))
    expect(send.submit).not.toHaveBeenCalled()
  })
})
