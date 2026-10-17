import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_VIEWER_HOLD_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({ capability: vi.fn(), call: vi.fn() }))
vi.mock('./runtime-rpc-client', () => ({ runtimeEnvironmentSupportsCapability: mocks.capability }))
vi.mock('./structured-agent-session-client', () => ({ callStructuredAgentSession: mocks.call }))
import { acquireStructuredViewerHold } from './structured-agent-viewer-hold'

const remote = { kind: 'environment', environmentId: 'owner' } as const
beforeEach(() => {
  vi.clearAllMocks()
  mocks.capability.mockResolvedValue(true)
  mocks.call.mockResolvedValue({ held: true, processState: 'exited' })
})
describe('viewer hold negotiation', () => {
  it('uses passive viewing on the bundled host without a remote probe', async () => {
    expect(
      await acquireStructuredViewerHold({ kind: 'local' }, 'chat', 'pane', () => true)
    ).toEqual({ processState: 'exited', fallback: false })
    expect(mocks.capability).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'agentSession.hold', {
      sessionId: 'chat',
      holderId: 'pane',
      mode: 'viewer'
    })
  })
  it('negotiates before sending the optional viewer field', async () => {
    await acquireStructuredViewerHold(remote, 'chat', 'pane', () => true)
    expect(mocks.capability).toHaveBeenCalledWith(
      'owner',
      STRUCTURED_AGENT_SESSION_VIEWER_HOLD_RUNTIME_CAPABILITY
    )
    expect(mocks.call).toHaveBeenCalledWith(remote, 'agentSession.hold', {
      sessionId: 'chat',
      holderId: 'pane',
      mode: 'viewer'
    })
  })
  it('keeps strict legacy params and marks the fallback on an old host', async () => {
    mocks.capability.mockResolvedValue(false)
    mocks.call.mockResolvedValue({ held: true })
    expect(await acquireStructuredViewerHold(remote, 'chat', 'pane', () => true)).toEqual({
      processState: 'unverifiable',
      fallback: true
    })
    expect(mocks.call).toHaveBeenCalledWith(remote, 'agentSession.hold', {
      sessionId: 'chat',
      holderId: 'pane'
    })
  })
  it('does not confuse an unreachable host with an old host or an exited process', async () => {
    mocks.capability.mockRejectedValue(new Error('host unreachable'))
    await expect(acquireStructuredViewerHold(remote, 'chat', 'pane', () => true)).rejects.toThrow(
      'host unreachable'
    )
    expect(mocks.call).not.toHaveBeenCalled()
  })
  it('does not acquire after the pane hides while negotiating', async () => {
    let visible = true
    mocks.capability.mockImplementation(async () => {
      visible = false
      return true
    })
    expect(await acquireStructuredViewerHold(remote, 'chat', 'pane', () => visible)).toBeNull()
    expect(mocks.call).not.toHaveBeenCalled()
  })
  it('requires explicit process evidence from a capable host', async () => {
    mocks.call.mockResolvedValue({ held: true })
    await expect(acquireStructuredViewerHold(remote, 'chat', 'pane', () => true)).rejects.toThrow(
      'did not confirm'
    )
  })
})
