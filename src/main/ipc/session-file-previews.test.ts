import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveAuthorizedReadPath: vi.fn(),
  createThumbnailFromPath: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  nativeImage: { createThumbnailFromPath: mocks.createThumbnailFromPath }
}))
vi.mock('./local-worktree-read-authorization', () => ({
  resolveAuthorizedReadPath: mocks.resolveAuthorizedReadPath
}))

import { probeLoopbackUrl, videoThumbnail } from './session-file-previews'

let server: Server | null = null
afterEach(async () => {
  vi.clearAllMocks()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

function listen(): Promise<number> {
  server = createServer((socket) => socket.end())
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

describe('probeLoopbackUrl', () => {
  it.each([
    'https://example.com:443/',
    'http://10.0.0.5:3000/',
    'http://localhost/',
    'file:///etc/passwd',
    42
  ])('refuses %s before opening any socket', async (url) => {
    await expect(probeLoopbackUrl(url)).rejects.toThrow('loopback')
  })

  it('reports a listening port as live and a closed one as stopped', async () => {
    const port = await listen()
    await expect(probeLoopbackUrl(`http://127.0.0.1:${port}/app`)).resolves.toBe('live')
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    await expect(probeLoopbackUrl(`http://127.0.0.1:${port}/app`)).resolves.toBe('stopped')
  })
})

describe('videoThumbnail', () => {
  const store = {} as never

  it('refuses relative paths and non-video files without touching the filesystem', async () => {
    await expect(videoThumbnail(store, { filePath: 'clip.mp4' })).rejects.toThrow('absolute')
    await expect(videoThumbnail(store, { filePath: '/w/secret.txt' })).rejects.toThrow('video')
    await expect(videoThumbnail(store, null)).rejects.toThrow('absolute')
    expect(mocks.resolveAuthorizedReadPath).not.toHaveBeenCalled()
  })

  it('goes through read authorization before the OS thumbnailer', async () => {
    mocks.resolveAuthorizedReadPath.mockRejectedValueOnce(new Error('Access denied'))
    await expect(videoThumbnail(store, { filePath: '/outside/clip.mp4' })).rejects.toThrow(
      'Access denied'
    )
    expect(mocks.createThumbnailFromPath).not.toHaveBeenCalled()
  })
})
