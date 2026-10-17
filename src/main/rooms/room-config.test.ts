import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ capture: vi.fn(), request: vi.fn(), directory: '' }))
vi.mock('../backoffice/console-workflow-person', () => ({
  captureConsoleWorkflowPerson: mocks.capture
}))
vi.mock('../backoffice/console-workflow-transport', () => ({
  requestConsoleWorkflow: mocks.request
}))
vi.mock('../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => mocks.directory
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.directory = mkdtempSync(join(tmpdir(), 'room-config-'))
  mocks.capture.mockResolvedValue({
    ok: true,
    data: {
      profileKey: 'profile',
      principal: 'person',
      baseUrl: 'https://console.example.com',
      isCurrent: () => true
    }
  })
})
afterEach(() => rmSync(mocks.directory, { recursive: true, force: true }))
describe('room discovery', () => {
  it('uses an explicit native capability while legacy history and writes remain available', async () => {
    const { getRoomConfig } = await import('./room-config')
    mocks.request.mockResolvedValue({
      ok: true,
      data: {
        ready: false,
        mode: 'legacy',
        nativeRooms: {
          ready: true,
          apiOrigin: 'https://api.example.com',
          frontendOrigin: 'https://example.com'
        }
      }
    })
    expect(await getRoomConfig()).toMatchObject({
      apiOrigin: 'https://api.example.com',
      mode: 'legacy'
    })
  })
  it('honors native refusal and never fills incomplete native discovery with fallback origins', async () => {
    const { getRoomConfig, configureRoomOrigins } = await import('./room-config')
    await configureRoomOrigins({
      apiOrigin: 'https://fallback.example.com',
      frontendOrigin: 'https://example.com'
    })
    mocks.request.mockResolvedValue({
      ok: true,
      data: { ready: true, mode: 'omniconsole', nativeRooms: { ready: false } }
    })
    await expect(getRoomConfig()).rejects.toMatchObject({ code: 'not_ready' })
    await configureRoomOrigins({
      apiOrigin: 'https://fallback.example.com',
      frontendOrigin: 'https://example.com'
    })
    mocks.request.mockResolvedValue({
      ok: true,
      data: { ready: false, mode: 'legacy', nativeRooms: { ready: true } }
    })
    await expect(getRoomConfig()).rejects.toMatchObject({ code: 'config_missing' })
  })
  it('refuses legacy discovery without an explicit native capability', async () => {
    const { getRoomConfig } = await import('./room-config')
    mocks.request.mockResolvedValue({ ok: true, data: { ready: true, mode: 'legacy' } })
    await expect(getRoomConfig()).rejects.toMatchObject({ code: 'not_ready' })
  })
  it('uses the signed console helper and caches its readiness result', async () => {
    const { getRoomConfig } = await import('./room-config')
    mocks.request.mockResolvedValue({
      ok: true,
      data: {
        ready: true,
        mode: 'omniconsole',
        apiOrigin: 'https://api.example.com',
        frontendOrigin: 'https://example.com'
      }
    })
    expect(await getRoomConfig()).toMatchObject({
      apiOrigin: 'https://api.example.com',
      mode: 'omniconsole'
    })
    await getRoomConfig()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.request.mock.calls[0].slice(0, 2)).toEqual(['/api/communication/config', 'GET'])
  })
  it('uses explicit fallback origins when discovery omits them, never bypassing not-ready', async () => {
    const { getRoomConfig, configureRoomOrigins } = await import('./room-config')
    mocks.request.mockResolvedValue({ ok: true, data: { ready: true, mode: 'omniconsole' } })
    await expect(getRoomConfig()).rejects.toMatchObject({ code: 'config_missing' })
    await configureRoomOrigins({
      apiOrigin: 'https://api.example.com',
      frontendOrigin: 'https://example.com'
    })
    expect(await getRoomConfig()).toMatchObject({ apiOrigin: 'https://api.example.com' })
    await configureRoomOrigins({
      apiOrigin: 'https://api.example.com',
      frontendOrigin: 'https://example.com'
    })
    mocks.request.mockResolvedValue({ ok: true, data: { ready: false, mode: 'omniconsole' } })
    await expect(getRoomConfig()).rejects.toMatchObject({ code: 'not_ready' })
  })
  it('fences account changes and refuses path-bearing or insecure fallback destinations', async () => {
    const { configureRoomOrigins, getRoomConfig } = await import('./room-config')
    for (const apiOrigin of [
      'http://api.example.com',
      'https://user:pass@api.example.com',
      'https://api.example.com/path',
      'not a URL'
    ]) {
      await expect(
        configureRoomOrigins({ apiOrigin, frontendOrigin: 'https://example.com' })
      ).rejects.toThrow()
    }
    mocks.capture.mockResolvedValue({ ok: false, error: { code: 'signed_out' } })
    await expect(getRoomConfig()).rejects.toMatchObject({ code: 'console_unavailable' })
  })
})
