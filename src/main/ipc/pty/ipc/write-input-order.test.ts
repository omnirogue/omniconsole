import { describe, expect, it, vi } from 'vitest'
import { createPtyWriteInput } from './write-input'

const state = vi.hoisted(() => ({
  writes: [] as string[],
  provider: {
    hasPty: () => true,
    write: vi.fn(),
    writeAccepted: vi.fn()
  }
}))
vi.mock('../provider/ownership-state', () => ({ ptyOwnership: new Map([['p', 'ssh-connection']]) }))
vi.mock('../provider/registry', () => ({ tryGetProviderForPty: () => state.provider }))
vi.mock('../../../runtime/agent-session-pty-write-gate', () => ({
  agentSessionPtyWriteGate: {
    admit: () => ({ admitted: true, sessionId: 's', runtimeFence: 1 }),
    readmit: () => ({ admitted: true })
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

describe('remote input after a shared viewport claim', () => {
  it('dispatches Enter before later text without an extra measurement microtask', async () => {
    state.writes = []
    state.provider.writeAccepted.mockImplementation((_id: string, data: string) => {
      state.writes.push(data)
      return Promise.resolve(true)
    })
    state.provider.write.mockImplementation((_id: string, data: string) => {
      state.writes.push(data)
      return true
    })
    const input = createPtyWriteInput({
      mainWindow: {} as never,
      clearHiddenRendererResizeOutput: () => {}
    })
    const claim = Promise.resolve(true)
    await Promise.all([
      claim.then(() => input.writePtyInputAccepted({ id: 'p', data: '\r' })),
      claim.then(() => input.writePtyInput({ id: 'p', data: 'next command' }))
    ])
    expect(state.writes).toEqual(['\r', 'next command'])
  })
})
