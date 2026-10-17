import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearNativeChatSessionOptionCacheForTests,
  mirrorNativeChatSessionOptionCache,
  readNativeChatSessionOptionCache,
  seedNativeChatAppliedSessionOptions,
  writeNativeChatSessionOptionCache
} from './native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'

describe('native chat PTY session options — relaunch surface', () => {
  beforeEach(() => clearNativeChatSessionOptionCacheForTests())

  it('confirmRelaunchedSessionOptions reports and persists model + effort', () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'codex', { model: 'gpt-5.5', effort: 'medium' })
    const persist = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'codex',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn(),
      persistSelection: persist
    })!

    surface.confirmRelaunchedSessionOptions({
      observed: { model: 'gpt-5.5', effort: 'high' },
      requested: { model: 'gpt-5.5', effort: 'high' },
      selectedOption: 'effort'
    })

    expect(surface.getSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'model',
          valueSource: 'reported',
          kind: expect.objectContaining({ currentValue: 'gpt-5.5' })
        }),
        expect.objectContaining({
          id: 'effort',
          valueSource: 'reported',
          kind: expect.objectContaining({ currentValue: 'high' })
        })
      ])
    )
    expect(persist.mock.calls.map(([call]) => call)).toEqual([
      { modelId: 'gpt-5.5', optionId: 'model', value: 'gpt-5.5', adoptModelAsLaunchDefault: true },
      { modelId: 'gpt-5.5', optionId: 'effort', value: 'high', adoptModelAsLaunchDefault: true }
    ])
  })

  it('confirmRelaunchedSessionOptions shows the observed effort but persists none on a model-only pick', () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'codex', { model: 'gpt-5.5' })
    const persist = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'codex',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn(),
      persistSelection: persist
    })!

    // No `-c` was sent; `medium` is Codex's own default for the new model.
    surface.confirmRelaunchedSessionOptions({
      observed: { model: 'gpt-5.2-codex', effort: 'medium' },
      requested: { model: 'gpt-5.2-codex' },
      selectedOption: 'model'
    })

    expect(surface.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: 'medium' }
    })
    expect(persist.mock.calls.map(([call]) => call)).toEqual([
      {
        modelId: 'gpt-5.2-codex',
        optionId: 'model',
        value: 'gpt-5.2-codex',
        adoptModelAsLaunchDefault: true
      }
    ])
  })

  it('confirmRelaunchedSessionOptions persists the model only when a model pick carried the effort', () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'codex', { model: 'gpt-5.6-sol', effort: 'high' })
    const persist = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'codex',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn(),
      persistSelection: persist
    })!

    // The person picked a model; `high` rode along on the launch line only. Writing
    // it into the new model's defaults would overwrite a saved effort nobody changed.
    surface.confirmRelaunchedSessionOptions({
      observed: { model: 'gpt-5.5', effort: 'high' },
      requested: { model: 'gpt-5.5', effort: 'high' },
      selectedOption: 'model'
    })

    expect(surface.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: 'high' }
    })
    expect(persist.mock.calls.map(([call]) => call)).toEqual([
      { modelId: 'gpt-5.5', optionId: 'model', value: 'gpt-5.5', adoptModelAsLaunchDefault: true }
    ])
  })

  it('dropDispatchedSessionOptions removes only dispatched entries', () => {
    writeNativeChatSessionOptionCache('pty-1', {
      agent: 'codex',
      model: { value: 'gpt-5.5', source: 'reported' },
      valuesByModel: {
        'gpt-5.5': { effort: { value: 'high', source: 'dispatched' } },
        'gpt-5.2-codex': { effort: { value: 'low', source: 'dispatched' } }
      }
    })
    const surface = createNativeChatPtySessionOptions({
      agent: 'codex',
      scopeKey: 'pty-1',
      mode: 'live',
      dispatchCommand: vi.fn()
    })!
    surface.dropDispatchedSessionOptions()
    // The reported model survives; its dispatched effort and the stray entry go.
    expect(surface.getSnapshot().find(({ id }) => id === 'model')).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: 'gpt-5.5' }
    })
    expect(surface.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'unknown'
    })
    expect(readNativeChatSessionOptionCache('pty-1')?.valuesByModel).toEqual({})

    writeNativeChatSessionOptionCache('pty-2', {
      agent: 'codex',
      model: { value: 'gpt-5.5', source: 'dispatched' },
      valuesByModel: { 'gpt-5.5': { effort: { value: 'high', source: 'dispatched' } } }
    })
    const dispatchedOnly = createNativeChatPtySessionOptions({
      agent: 'codex',
      scopeKey: 'pty-2',
      mode: 'live',
      dispatchCommand: vi.fn()
    })!
    dispatchedOnly.dropDispatchedSessionOptions()
    expect(dispatchedOnly.getSnapshot()).toHaveLength(1)
    expect(dispatchedOnly.getSnapshot()[0]).toMatchObject({ valueSource: 'unknown' })
  })

  it('mirrorNativeChatSessionOptionCache clones a record onto another scope and no-ops when absent', () => {
    seedNativeChatAppliedSessionOptions('pty-1', 'codex', { model: 'gpt-5.5', effort: 'high' })
    mirrorNativeChatSessionOptionCache('pty-1', 'tab-1')
    const mirrored = readNativeChatSessionOptionCache('tab-1')
    expect(mirrored).toEqual(readNativeChatSessionOptionCache('pty-1'))
    expect(mirrored).not.toBe(readNativeChatSessionOptionCache('pty-1'))
    mirrorNativeChatSessionOptionCache('missing', 'tab-2')
    expect(readNativeChatSessionOptionCache('tab-2')).toBeNull()
  })
})
