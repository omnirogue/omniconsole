import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import {
  clearNativeChatSessionOptionCacheForTests,
  seedNativeChatAppliedSessionOptions
} from './native-chat-session-option-cache'
import {
  createNativeChatPtySessionOptions,
  type CreateNativeChatPtySessionOptionsArgs
} from './native-chat-pty-session-options'
import type { NativeChatSessionOptionRelaunch } from './native-chat-session-option-command-dispatch'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    values
      ? Object.entries(values).reduce(
          (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
          fallback
        )
      : fallback
}))

function committingRelaunch(): ReturnType<typeof vi.fn> & NativeChatSessionOptionRelaunch {
  return vi.fn(async ({ onCommitted }: Parameters<NativeChatSessionOptionRelaunch>[0]) => {
    onCommitted()
  }) as never
}

function surfaceFor(args: Partial<CreateNativeChatPtySessionOptionsArgs> = {}) {
  const dispatchCommand = vi.fn()
  const persistSelection = vi.fn()
  const surface = createNativeChatPtySessionOptions({
    agent: 'codex',
    scopeKey: 'pty-1',
    mode: 'live',
    dispatchCommand,
    persistSelection,
    ...args
  })!
  return { surface, dispatchCommand, persistSelection }
}

function descriptor(snapshot: SessionOptionDescriptor[], id: string): SessionOptionDescriptor {
  const found = snapshot.find((entry) => entry.id === id)
  if (!found) {
    throw new Error(`missing descriptor ${id}`)
  }
  return found
}

describe('applyResumeRelaunch', () => {
  beforeEach(() => clearNativeChatSessionOptionCacheForTests())

  it('effort pick relaunches with the tracked model and marks both dispatched', async () => {
    const relaunch = committingRelaunch()
    const { surface, dispatchCommand, persistSelection } = surfaceFor({
      reportedValues: { model: 'gpt-5.5', effort: 'medium' },
      relaunchSessionOptions: relaunch
    })
    const listener = vi.fn()
    surface.subscribe(listener)

    await surface.setOption('effort', 'high')

    expect(relaunch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requested: { model: 'gpt-5.5', effort: 'high' },
        selectedOption: 'effort'
      })
    )
    const published = listener.mock.calls.at(-1)?.[0] as SessionOptionDescriptor[]
    expect(descriptor(published, 'effort')).toMatchObject({
      valueSource: 'dispatched',
      kind: { currentValue: 'high' }
    })
    expect(descriptor(published, 'model')).toMatchObject({
      valueSource: 'dispatched',
      kind: { currentValue: 'gpt-5.5' }
    })
    expect(persistSelection).not.toHaveBeenCalled()
    expect(dispatchCommand).not.toHaveBeenCalled()
  })

  it('model pick carries the current effort only when the destination supports it', async () => {
    const relaunch = committingRelaunch()
    const { surface } = surfaceFor({
      reportedValues: { model: 'gpt-5.6-sol', effort: 'ultra' },
      relaunchSessionOptions: relaunch
    })
    await surface.setOption('model', 'gpt-5.5')
    expect(relaunch).toHaveBeenLastCalledWith(
      expect.objectContaining({ requested: { model: 'gpt-5.5' }, selectedOption: 'model' })
    )
    expect(descriptor(surface.getSnapshot(), 'effort').valueSource).toBe('unknown')

    surface.reportSessionOptions({ model: 'gpt-5.6-sol', effort: 'high' })
    await surface.setOption('model', 'gpt-5.5')
    // The carried effort is on the launch line, but the pick itself was the model.
    expect(relaunch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requested: { model: 'gpt-5.5', effort: 'high' },
        selectedOption: 'model'
      })
    )
    expect(descriptor(surface.getSnapshot(), 'effort')).toMatchObject({
      valueSource: 'dispatched',
      kind: { currentValue: 'high' }
    })
  })

  it('same value is refused without relaunch', async () => {
    const relaunch = committingRelaunch()
    const { surface } = surfaceFor({
      reportedValues: { model: 'gpt-5.5', effort: 'medium' },
      relaunchSessionOptions: relaunch
    })
    await expect(surface.setOption('effort', 'medium')).rejects.toThrow(
      'Codex is already using GPT-5.5 · Medium.'
    )
    await expect(surface.setOption('model', 'gpt-5.5')).rejects.toThrow(
      'Codex is already using GPT-5.5.'
    )
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('a refusal thrown before onCommitted leaves tracked truth untouched', async () => {
    const relaunch = vi.fn(async () => {
      throw new Error('Codex is still working. Wait for the turn to finish, then change this.')
    })
    const { surface } = surfaceFor({
      reportedValues: { model: 'gpt-5.5', effort: 'medium' },
      relaunchSessionOptions: relaunch as never
    })
    const before = surface.getSnapshot()
    await expect(surface.setOption('effort', 'high')).rejects.toThrow('Codex is still working')
    expect(surface.getSnapshot()).toEqual(before)
    expect(descriptor(surface.getSnapshot(), 'effort')).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: 'medium' }
    })
  })

  it('refuses when no relaunch handler is wired', async () => {
    const { surface, dispatchCommand } = surfaceFor({
      reportedValues: { model: 'gpt-5.5', effort: 'medium' }
    })
    await expect(surface.setOption('effort', 'high')).rejects.toThrow(
      "Codex restarts aren't available in this pane."
    )
    expect(dispatchCommand).not.toHaveBeenCalled()
  })

  it('a model pick from a launch-applied seed relaunches without an effort', async () => {
    const relaunch = committingRelaunch()
    seedNativeChatAppliedSessionOptions('pty-1', 'codex', { model: 'gpt-5.5' })
    const { surface } = surfaceFor({ relaunchSessionOptions: relaunch })
    await surface.setOption('model', 'gpt-5.2-codex')
    expect(relaunch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ requested: { model: 'gpt-5.2-codex' } })
    )
  })

  it('invokeAction on a resume-relaunch option throws This option requires a value', async () => {
    const { surface } = surfaceFor({
      reportedValues: { model: 'gpt-5.5', effort: 'medium' },
      relaunchSessionOptions: committingRelaunch()
    })
    await expect(surface.invokeAction('effort')).rejects.toThrow('This option requires a value.')
    await expect(surface.invokeAction('model')).rejects.toThrow('This option requires a value.')
  })
})
