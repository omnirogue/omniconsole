import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))
vi.mock('node-pty', () => ({ spawn: mocks.mockPtySpawn }))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mocks.mockCreateShellPromptReadinessProbe
}))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest
} from './pty-handler-test-harness'

describe('relay PTY accepted input', () => {
  let harness: ReturnType<typeof beginPtyHandlerTest>
  beforeEach(() => {
    harness = beginPtyHandlerTest(mocks)
  })
  afterEach(async () => {
    await endPtyHandlerTest(harness.handler, harness.originalPlatform)
  })
  const spawn = async () => createPtyRequestHelpers(() => harness.dispatcher).spawnPty()

  it('advertises support and acknowledges only the exact spawned terminal incarnation', async () => {
    const target = await spawn()
    await expect(harness.dispatcher.callRequest('pty.getCapabilities')).resolves.toMatchObject({
      acceptedInputVersion: 1
    })
    mocks.mockPtyInstance.write.mockClear()
    await expect(
      harness.dispatcher.callRequest('pty.writeAccepted', { ...target, data: '\r' })
    ).resolves.toEqual({ accepted: true, incarnationId: target.incarnationId })
    expect(mocks.mockPtyInstance.write).toHaveBeenCalledExactlyOnceWith('\r')
  })

  it('refuses missing, stale or malformed identities without touching the terminal', async () => {
    const target = await spawn()
    mocks.mockPtyInstance.write.mockClear()
    for (const params of [
      { id: target.id, data: '\r' },
      { ...target, incarnationId: 'replaced', data: '\r' },
      { ...target, id: 'missing', data: '\r' },
      { ...target, data: 42 }
    ]) {
      await expect(harness.dispatcher.callRequest('pty.writeAccepted', params)).resolves.toEqual({
        accepted: false
      })
    }
    expect(mocks.mockPtyInstance.write).not.toHaveBeenCalled()
  })

  it('refuses a disconnected request even if its PTY remains live', async () => {
    const target = await spawn()
    mocks.mockPtyInstance.write.mockClear()
    await expect(
      harness.dispatcher.callRequest(
        'pty.writeAccepted',
        { ...target, data: '\r' },
        { isStale: () => true }
      )
    ).resolves.toEqual({ accepted: false })
    expect(mocks.mockPtyInstance.write).not.toHaveBeenCalled()
  })

  it('reports a native write failure without replay', async () => {
    const target = await spawn()
    mocks.mockPtyInstance.write.mockClear().mockImplementationOnce(() => {
      throw new Error('PTY unavailable')
    })
    await expect(
      harness.dispatcher.callRequest('pty.writeAccepted', { ...target, data: '\r' })
    ).resolves.toEqual({ accepted: false })
    expect(mocks.mockPtyInstance.write).toHaveBeenCalledTimes(1)
  })

  it('preserves the existing notification path for older clients', async () => {
    const target = await spawn()
    mocks.mockPtyInstance.write.mockClear()
    harness.dispatcher.callNotification('pty.data', {
      id: target.id,
      data: 'ordinary terminal input'
    })
    expect(mocks.mockPtyInstance.write).toHaveBeenCalledExactlyOnceWith('ordinary terminal input')
  })
})
