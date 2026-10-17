import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNativeChatSessionOptionCacheForTests } from './native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
import type { NativeChatSessionOptionDispatchResult } from './native-chat-session-option-command-dispatch'

const original = 'openrouter/google/gemini-2.5-flash-lite'
const requested = 'openrouter/google/gemini-2.5-flash'

function modelChange() {
  let reply!: (result: NativeChatSessionOptionDispatchResult) => void
  const result = new Promise<NativeChatSessionOptionDispatchResult>((resolve) => {
    reply = resolve
  })
  const dispatchCommand = vi.fn(() => result)
  const persistSelection = vi.fn()
  const surface = createNativeChatPtySessionOptions({
    agent: 'omp',
    scopeKey: 'owned-omp',
    mode: 'live',
    initialModels: [original, requested].map((id) => ({ id, label: id, options: [] })),
    reportedValues: { model: original },
    dispatchCommand,
    persistSelection
  })!
  return { surface, reply, dispatchCommand, persistSelection }
}

beforeEach(() => clearNativeChatSessionOptionCacheForTests())

describe('OMP model apply truth', () => {
  it('keeps the reported model until the exact native choice is confirmed', async () => {
    const r = modelChange()
    const pending = r.surface.setOption('model', requested)
    await vi.waitFor(() =>
      expect(r.dispatchCommand).toHaveBeenCalledWith(`/switch ${requested}`, {
        detectAgentInteraction: 'omp-model-switch-confirmation',
        expectedChoiceLabel: requested,
        expectedChoiceId: requested
      })
    )
    expect(r.surface.getSnapshot()[0]).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: original }
    })
    expect(r.persistSelection).not.toHaveBeenCalled()
    r.reply({ outcome: 'applied' })
    await pending
    expect(r.surface.getSnapshot()[0]).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: requested }
    })
    expect(r.persistSelection).toHaveBeenCalledOnce()
  })

  it('refuses an unconfirmed switch without persisting the requested model', async () => {
    const r = modelChange()
    const pending = r.surface.setOption('model', requested)
    const rejected = expect(pending).rejects.toThrow('Could not verify the model change')
    r.reply({ outcome: 'unknown' })
    await rejected
    expect(r.persistSelection).not.toHaveBeenCalled()
    expect(r.surface.getSnapshot()[0]).toMatchObject({ valueSource: 'unknown' })
  })
})
