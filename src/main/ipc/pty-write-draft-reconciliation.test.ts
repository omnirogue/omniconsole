import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  revision: 0,
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  clear: vi.fn(),
  accepted: vi.fn(),
  plain: vi.fn(() => true)
}))
vi.mock('./pty-host-bindings', () => ({
  getPtyIpc: () => ({
    on: (name: string, listener: (...args: unknown[]) => unknown) =>
      state.listeners.set(name, listener),
    handle: (name: string, listener: (...args: unknown[]) => unknown) =>
      state.handlers.set(name, listener),
    removeAllListeners: vi.fn()
  })
}))
vi.mock('./pty/ipc/write-input', () => ({
  createPtyWriteInput: () => ({
    writePtyInput: state.plain,
    writePtyInputAccepted: state.accepted,
    isPtyWritePayload: () => true,
    isPtyViewportClaimPayload: () => true,
    isPtyWriteEventFromMainWindow: () => true
  })
}))
vi.mock('../runtime/terminal-unresolved-draft', () => ({
  terminalDraftRevision: () => state.revision,
  markUnresolvedDraft: () => {
    state.revision++
  },
  clearUnresolvedDraft: state.clear
}))
import { installPtyWriteIpcHandlers } from './pty/ipc/write'

beforeEach(() => {
  state.clear.mockClear()
  state.accepted.mockReset()
  state.revision = 0
  installPtyWriteIpcHandlers({
    mainWindow: { webContents: {} } as never,
    clearHiddenRendererResizeOutput: () => {}
  })
})
describe('manual Enter reconciliation', () => {
  it('retains a newer draft when an older Enter finishes later', async () => {
    let finish!: (value: boolean) => void
    state.accepted.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    )
    const entered = state.handlers.get('pty:writeAccepted')!({}, { id: 'p', data: '\r' })
    state.listeners.get('pty:write')!({}, { id: 'p', data: 'new text' })
    finish(true)
    await entered
    expect(state.clear).not.toHaveBeenCalled()
  })
  it('clears only the unchanged draft after a positive owner receipt', async () => {
    state.accepted.mockResolvedValue(true)
    await state.handlers.get('pty:writeAccepted')!({}, { id: 'p', data: '\r' })
    expect(state.clear).toHaveBeenCalledExactlyOnceWith('p')
  })
  it('retains quarantine when Enter was not acknowledged', async () => {
    state.accepted.mockResolvedValue(false)
    await state.handlers.get('pty:writeAccepted')!({}, { id: 'p', data: '\r' })
    expect(state.clear).not.toHaveBeenCalled()
  })
})

it('pins fire-and-forget Enter to admission before waiting for a viewport claim', async () => {
  let claim!: (value: boolean) => void
  const claimPending = new Promise<boolean>((resolve) => {
    claim = resolve
  })
  let submitted!: () => void
  const delivered = new Promise<void>((resolve) => {
    submitted = resolve
  })
  state.accepted.mockImplementation(async () => {
    submitted()
    return true
  })
  installPtyWriteIpcHandlers({
    mainWindow: { webContents: {} } as never,
    runtime: { claimRemoteDesktopHost: () => claimPending } as never,
    clearHiddenRendererResizeOutput: () => {}
  })
  state.listeners.get('pty:claimViewport')!({}, { id: 'p', cols: 80, rows: 24 })
  state.listeners.get('pty:write')!({}, { id: 'p', data: '\r' })
  state.listeners.get('pty:write')!({}, { id: 'p', data: 'new draft' })
  claim(true)
  await delivered
  await Promise.resolve()
  expect(state.accepted).toHaveBeenCalledExactlyOnceWith({ id: 'p', data: '\r' })
  expect(state.clear).not.toHaveBeenCalled()
})
