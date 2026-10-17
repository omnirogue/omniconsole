import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPtyWriteInput } from './write-input'

const state = vi.hoisted(() => ({
  attached: new Set<string>(),
  writes: [] as [string, string][],
  ownership: new Map<string, string | null>(),
  runtimeFence: 1
}))
vi.mock('../provider/ownership-state', () => ({ ptyOwnership: state.ownership }))
vi.mock('../provider/registry', () => ({
  tryGetProviderForPty: () => ({
    hasPty: (id: string) => state.attached.has(id),
    write: (id: string, data: string) => {
      state.writes.push([id, data])
      return true
    }
  })
}))
vi.mock('../../../runtime/agent-session-pty-write-gate', () => ({
  agentSessionPtyWriteGate: {
    admit: () => ({ admitted: true, sessionId: 's', runtimeFence: state.runtimeFence }),
    readmit: (_id: string, admitted: { runtimeFence: number }) => ({
      admitted: admitted.runtimeFence === state.runtimeFence,
      refusal: 'stale-runtime'
    })
  }
}))
vi.mock('../agent-session-write-refusal-report', () => ({
  reportAgentSessionWriteRefusal: vi.fn()
}))
vi.mock('../delivery/visibility-state', () => ({
  lastInputAtByPty: new Map(),
  interactiveOutputCharsByPty: new Map(),
  visibleRendererPtys: new Set()
}))

function inputWith(attach: (id: string) => Promise<boolean>) {
  const attachUnattachedLocalDaemonPtyForInput = vi.fn(attach)
  const input = createPtyWriteInput({
    mainWindow: {} as never,
    runtime: {
      getDriver: () => ({ kind: 'idle' }),
      attachUnattachedLocalDaemonPtyForInput
    } as never,
    clearHiddenRendererResizeOutput: () => {}
  })
  return { input, attachUnattachedLocalDaemonPtyForInput }
}

describe('accepted input to a daemon session no pane has re-attached since launch', () => {
  beforeEach(() => {
    state.attached.clear()
    state.writes = []
    state.ownership.clear()
    state.runtimeFence = 1
  })

  it('attaches the session headlessly, then delivers the keys', async () => {
    state.ownership.set('restored', null)
    const { input, attachUnattachedLocalDaemonPtyForInput } = inputWith(async (id) => {
      state.attached.add(id)
      return true
    })
    await expect(input.writePtyInputAccepted({ id: 'restored', data: '1' })).resolves.toBe(true)
    expect(attachUnattachedLocalDaemonPtyForInput).toHaveBeenCalledExactlyOnceWith('restored')
    expect(state.writes).toEqual([['restored', '1']])
  })

  it('refuses without writing when the session cannot be attached', async () => {
    state.ownership.set('gone', null)
    const { input } = inputWith(async () => false)
    await expect(input.writePtyInputAccepted({ id: 'gone', data: '1' })).resolves.toBe(false)
    expect(state.writes).toEqual([])
  })

  it('refuses when the attach reports success but the session is still unknown', async () => {
    state.ownership.set('restored', null)
    const { input } = inputWith(async () => true)
    await expect(input.writePtyInputAccepted({ id: 'restored', data: '1' })).resolves.toBe(false)
    expect(state.writes).toEqual([])
  })

  it('refuses an answer when the session lease changes while attach is pending', async () => {
    state.ownership.set('restored', null)
    let finishAttach!: (attached: boolean) => void
    const { input } = inputWith(() => new Promise((resolve) => (finishAttach = resolve)))
    const accepted = input.writePtyInputAccepted({ id: 'restored', data: '1' })
    state.runtimeFence = 2
    state.attached.add('restored')
    finishAttach(true)
    await expect(accepted).resolves.toBe(false)
    expect(state.writes).toEqual([])
  })

  it('never attaches a session another connection owns', () => {
    state.ownership.set('remote', 'ssh-connection')
    const { input, attachUnattachedLocalDaemonPtyForInput } = inputWith(async () => true)
    expect(input.writePtyInputAccepted({ id: 'remote', data: '1' })).toBe(false)
    expect(attachUnattachedLocalDaemonPtyForInput).not.toHaveBeenCalled()
  })

  it('does not attach a session that is already attached', () => {
    state.ownership.set('live', null)
    state.attached.add('live')
    const { input, attachUnattachedLocalDaemonPtyForInput } = inputWith(async () => true)
    expect(input.writePtyInputAccepted({ id: 'live', data: '1' })).toBe(true)
    expect(attachUnattachedLocalDaemonPtyForInput).not.toHaveBeenCalled()
    expect(state.writes).toEqual([['live', '1']])
  })
})
