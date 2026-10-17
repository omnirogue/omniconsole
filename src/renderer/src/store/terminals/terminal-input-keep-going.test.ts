import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ typing: vi.fn(), record: vi.fn() }))
vi.mock('@/components/next-steps/next-steps-person-typing', () => ({
  notePersonTypingInConversation: mocks.typing
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ recordTerminalInput: mocks.record }) }
}))

import { createTerminalEphemeralActions } from './terminal-ephemeral-state'
import { recordTerminalUserInputForLeaf } from '@/components/terminal-pane/terminal-input-activity'
import { isTypedTerminalInput } from '@/components/terminal-pane/pty-connection/pty-keyboard-submit'

const LEAF = '0b7c2a4e-5d1f-4c3a-9e8b-1a2b3c4d5e6f'

beforeEach(() => vi.clearAllMocks())

it('a runtime or queued write marks hibernation activity but is never the person typing', () => {
  const state = { lastTerminalInputAtByPaneKey: {} as Record<string, number> }
  const actions = createTerminalEphemeralActions(
    ((update: (s: typeof state) => Partial<typeof state>) =>
      Object.assign(state, update(state))) as never,
    (() => state) as never
  )
  // Keep going's own queued prompt reaches the pane through this marker.
  actions.recordTerminalInput('tab-1:leaf-1', 1_000)
  expect(state.lastTerminalInputAtByPaneKey['tab-1:leaf-1']).toBe(1_000)
  expect(mocks.typing).not.toHaveBeenCalled()
})

it('the person’s own input (keys, paste, quick command) tells Keep going they are typing', () => {
  recordTerminalUserInputForLeaf('tab-1', LEAF)
  expect(mocks.record).toHaveBeenCalledWith(`tab-1:${LEAF}`)
  expect(mocks.typing).toHaveBeenCalledWith(`tab-1:${LEAF}`)
})

it('reads keys the person pressed as typing, and xterm’s own replies and reports as not', () => {
  for (const typed of [
    'a',
    'hello',
    '\r',
    '\x7f',
    '\x03',
    '\x1b',
    '\x1b\r',
    '\x1b[200~text\x1b[201~'
  ]) {
    expect(isTypedTerminalInput(typed)).toBe(true)
  }
  for (const reply of [
    '',
    '\x1b[I',
    '\x1b[O',
    '\x1b[?1;2c',
    '\x1b[12;1R',
    '\x1b]11;rgb:0000/0000/0000\x07',
    '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
    '\x1bP1$r0 q\x1b\\',
    '\x1b[<0;10;5M',
    '\x1b[M !!',
    '\x1b[A'
  ]) {
    expect(isTypedTerminalInput(reply)).toBe(false)
  }
})
