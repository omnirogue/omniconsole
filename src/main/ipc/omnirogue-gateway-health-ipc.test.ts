import { describe, expect, it, vi } from 'vitest'
import { RoomError } from '../rooms/room-error'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

const { registerOmniRogueGatewayHealthIpc } = await import('./omnirogue-gateway-health-ipc')

describe('registerOmniRogueGatewayHealthIpc', () => {
  it('probes the gateway catalog on demand without starting background polling', async () => {
    const request = vi.fn(async () => ({
      data: [
        { id: 'claude-opus-5-5', owned_by: 'anthropic' },
        { id: 'gpt-6-astra', owned_by: 'openai' },
        { id: 'gemini-4-argon', owned_by: 'google' }
      ]
    }))
    const poller = registerOmniRogueGatewayHealthIpc(request)
    const snapshot = (await handlers.get('omnirogue:gateway:check-health')?.()) as {
      state: string
    }
    expect(request).toHaveBeenCalledWith('/v1/models')
    expect(snapshot.state).not.toBe('unknown')
    expect(poller.isRunning()).toBe(false)
  })

  it('reports a rejected token as unauthorized', async () => {
    registerOmniRogueGatewayHealthIpc(async () => {
      throw new RoomError('device_unauthorized')
    })
    const snapshot = (await handlers.get('omnirogue:gateway:check-health')?.()) as {
      state: string
    }
    expect(snapshot.state).toBe('unauthorized')
  })
})
