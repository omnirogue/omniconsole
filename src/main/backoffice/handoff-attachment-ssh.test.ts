import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { captureHandoffAttachment } from './handoff-attachment-capture'
import { createHandoffAttachmentIo } from './handoff-attachment-source'

const connectionId = 'handoff-attachment-test'

function remoteProvider(root = '/remote/chosen') {
  const file = `${root}/plan.md`
  const stats = (path: string): FileStat => ({
    type: path === root ? 'directory' : 'file',
    size: path === root ? 512 : 3,
    mode: path === root ? 0o040755 : 0o100644,
    mtime: 10,
    mtimeMs: 10,
    ctimeMs: 11,
    dev: 1,
    ino: path === root ? 2 : 3,
    exactReadIdentity: 1
  })
  const provider = {
    realpath: vi.fn(async (path: string) => path),
    lstat: vi.fn(async (path: string) => stats(path)),
    readDir: vi.fn(async () => [{ name: 'plan.md', isDirectory: false, isSymlink: false }]),
    readExactFile: vi.fn(async () => ({ isBinary: true, content: 'AID/' }))
  }
  registerSshFilesystemProvider(connectionId, provider as unknown as IFilesystemProvider)
  return { provider, root, file }
}

afterEach(() => unregisterSshFilesystemProvider(connectionId))

describe('handoff attachments on SSH owners', () => {
  it('archives only the selected host bytes with exact identity and preserves Windows paths', async () => {
    const { provider } = remoteProvider('C:/work/chosen')
    const file = await captureHandoffAttachment(
      'C:/work/chosen',
      createHandoffAttachmentIo(connectionId)
    )
    expect(file.name).toBe('chosen.tar.gz')
    expect(provider.readExactFile).toHaveBeenCalledExactlyOnceWith(
      'C:\\work\\chosen\\plan.md',
      expect.any(Number),
      {
        size: 3,
        mode: 0o100644,
        mtimeMs: 10,
        ctimeMs: 11,
        dev: 1,
        ino: 3
      }
    )
    expect(provider.readDir).toHaveBeenCalledWith('C:/work/chosen')
  })

  it('does not fall back to local files when the connection is missing', () => {
    expect(() => createHandoffAttachmentIo(connectionId)).toThrow('Reconnect')
  })

  it('rejects replacement of the remote provider during a directory listing', async () => {
    const { provider, root } = remoteProvider()
    provider.readDir.mockImplementation(async () => {
      remoteProvider()
      return [{ name: 'plan.md', isDirectory: false, isSymlink: false }]
    })
    await expect(
      captureHandoffAttachment(root, createHandoffAttachmentIo(connectionId))
    ).rejects.toThrow('computer changed')
    expect(provider.readExactFile).not.toHaveBeenCalled()
  })

  it('requires safe exact-read identity from older hosts before any file transfer', async () => {
    const { provider, root } = remoteProvider()
    provider.lstat.mockResolvedValue({ type: 'directory', size: 1, mtime: 0 })
    await expect(
      captureHandoffAttachment(root, createHandoffAttachmentIo(connectionId))
    ).rejects.toThrow('Update Orca')
    expect(provider.readExactFile).not.toHaveBeenCalled()
  })

  it('refuses traversal from a malformed directory listing before file transfer', async () => {
    const { provider, root } = remoteProvider()
    provider.readDir.mockResolvedValue([
      { name: '../outside', isDirectory: false, isSymlink: false }
    ])
    await expect(
      captureHandoffAttachment(root, createHandoffAttachmentIo(connectionId))
    ).rejects.toThrow('safely')
    expect(provider.readExactFile).not.toHaveBeenCalled()
  })
})
