// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { resumedAgentInputReady, useNativeChatResumeReady } from './use-native-chat-resume-ready'

const CODEX =
  'OpenAI Codex\nmodel: gpt-5.5 medium\n› Ask Codex to do anything\ngpt-5.5 medium · ~/repo'
const CLAUDE = 'Claude Code v2.1.270\nOpus 5 with high effort · Claude Max\n────────\n❯ \n────────'
// The real 0.154 resumed process reports `default`, without an explicit effort
// in either its startup box or footer. No new turn/hook is needed to use it.
const CODEX_DEFAULT = [
  '│ >_ OpenAI Codex (v0.154.0) │',
  '│ model: gpt-6-astra /model to change │',
  '› Previous user instruction',
  '• Previous response',
  '■ Conversation interrupted - tell the model what to do differently.',
  '',
  '› Ask Codex to do anything',
  '',
  '  gpt-6-astra default · /private/tmp/resumed-repo · Run UI diagnostic'
].join('\n')
afterEach(() => vi.useRealTimers())

it('requires the resumed agent input, not just its startup header or trust menu', () => {
  expect(resumedAgentInputReady('codex', CODEX)).toBe(true)
  expect(resumedAgentInputReady('claude', CLAUDE)).toBe(true)
  expect(
    resumedAgentInputReady('claude', 'Claude Code\nOpus 5 with high effort · Claude Max')
  ).toBe(false)
  expect(resumedAgentInputReady('codex', 'OpenAI Codex\nmodel: gpt-5.5 medium')).toBe(false)
  expect(
    resumedAgentInputReady(
      'claude',
      `${CLAUDE}\nDo you trust the files in this folder?\n❯ Yes, I trust this folder`
    )
  ).toBe(false)
})

it('accepts the resumed default-effort input without claiming a concrete effort', () => {
  expect(resumedAgentInputReady('codex', CODEX_DEFAULT)).toBe(true)
  expect(
    resumedAgentInputReady(
      'codex',
      '\x1b[1m›\x1b[0m Ask Codex to do anything\r\n \r\n  \x1b[33mgpt-6-astra default\x1b[0m · ~/repo'
    )
  ).toBe(true)
  expect(resumedAgentInputReady('codex', 'gpt-6-astra default · ~/repo')).toBe(false)
  expect(
    resumedAgentInputReady('codex', '› Old prompt\n• Old response\ngpt-6-astra default · ~/repo')
  ).toBe(false)
  expect(
    resumedAgentInputReady('codex', '› Ask Codex to do anything\ngpt-6-astra unknown · ~/repo')
  ).toBe(false)
})

it('keeps default-effort resume blocked while a startup intervention owns input', () => {
  expect(
    resumedAgentInputReady(
      'codex',
      `${CODEX_DEFAULT}\nHooks need review\n6 hooks are new or changed.\n1. Review hooks\n2. Trust all and continue\n3. Continue without trusting (hooks won't run)\nPress enter to confirm or esc to go back`
    )
  ).toBe(false)
  expect(
    resumedAgentInputReady(
      'codex',
      `${CODEX_DEFAULT}\nDo you trust the contents of this directory?`
    )
  ).toBe(false)
})

it('releases an idle default-effort resume and waits again when the PTY changes', async () => {
  vi.useFakeTimers()
  let frame: string | null = null
  const readScreen = vi.fn(() => frame)
  const props = {
    resuming: true,
    active: true,
    paneKey: 'resumed-tab:leaf',
    ptyId: 'resumed-pty',
    agent: 'codex',
    readScreen
  }
  const { result, rerender, unmount } = renderHook(useNativeChatResumeReady, {
    initialProps: props
  })
  expect(result.current).toBe(false)
  // The resume claim may settle before Codex paints the input. No transcript
  // event or new agent-status hook follows the idle startup frame.
  rerender({ ...props, resuming: false })
  expect(result.current).toBe(false)
  frame = CODEX_DEFAULT
  await act(async () => vi.advanceTimersByTimeAsync(250))
  expect(result.current).toBe(true)
  const reads = readScreen.mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(readScreen).toHaveBeenCalledTimes(reads)

  frame = null
  rerender({ ...props, resuming: false, ptyId: 'replacement-pty' })
  expect(result.current).toBe(false)
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(result.current).toBe(false)
  frame = CODEX_DEFAULT
  await act(async () => vi.advanceTimersByTimeAsync(250))
  expect(result.current).toBe(true)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('holds the resume composer through an early hook and releases it when input is drawn', async () => {
  vi.useFakeTimers()
  let frame: string | null = null
  const readScreen = vi.fn(() => frame)
  const initialProps = {
    resuming: true,
    active: true,
    paneKey: 'tab:leaf',
    ptyId: 'pty',
    agent: 'claude',
    readScreen
  }
  const { result, rerender, unmount } = renderHook(useNativeChatResumeReady, { initialProps })
  expect(result.current).toBe(false)
  rerender({ ...initialProps, resuming: false })
  expect(result.current).toBe(false)
  frame = CLAUDE
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(result.current).toBe(true)
  const reads = readScreen.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(readScreen).toHaveBeenCalledTimes(reads)
  rerender({ ...initialProps, resuming: false, paneKey: 'tab:sibling' })
  expect(result.current).toBe(true)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
