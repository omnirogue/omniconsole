import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkspaceFileDeliveryRequest } from '../../shared/workspace-file-delivery'
import { deliverWorkspaceFile } from './workspace-file-delivery'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-delivery-')))
  await mkdir(join(root, 'Desktop'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function fixture() {
  const bytes = Buffer.from([0, 255, 128, 10])
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const assertOwner = vi.fn(async () => {})
  const host = {
    runtimeId: '11111111-1111-4111-8111-111111111111',
    desktopPath: () => join(root, 'Desktop'),
    captureOwner: vi.fn(async () => ({
      worktreeId: 'folder:source',
      workspacePath: '/worker/source',
      expectedExecutionHostId: 'ssh:worker' as const,
      expectedSshTargetId: 'worker',
      assertOwner
    })),
    captureSource: vi.fn(async () => ({
      manifest: {
        snapshotId: 'snapshot',
        files: [
          {
            id: 'file',
            name: 'report.pdf',
            targetPath: 'report.pdf',
            size: bytes.length,
            sha256,
            executable: false
          }
        ],
        deletions: [],
        warnings: [],
        source: { connectionId: 'worker' }
      },
      bytes: new Map([['file', bytes]])
    }))
  }
  const request: WorkspaceFileDeliveryRequest = {
    worktree: 'id:folder:source',
    sourcePath: 'report.pdf',
    expectedSourceHostId: 'ssh:worker',
    recipientRuntimeId: host.runtimeId,
    destination: { kind: 'desktop', name: 'report.pdf' }
  }
  const destination = join(root, 'Desktop', 'report.pdf')
  return { host, request, destination, bytes, sha256, assertOwner }
}

it('delivers exact binary bytes to the recipient desktop and reconciles the same destination', async () => {
  const { host, request, destination, bytes, sha256 } = fixture()
  const receipt = await deliverWorkspaceFile(host, request)
  expect(receipt).toMatchObject({
    disposition: 'delivered',
    recipient: { path: destination },
    sha256,
    size: bytes.length
  })
  expect(await readFile(destination)).toEqual(bytes)
  expect(host.captureSource).toHaveBeenCalledWith(
    {
      worktree: 'id:folder:source',
      paths: ['report.pdf'],
      includeDirtyTracked: false,
      expectedConnectionId: 'worker'
    },
    undefined
  )
  await expect(
    deliverWorkspaceFile(host, { ...request, expectedSha256: sha256 })
  ).resolves.toMatchObject({ disposition: 'already-present', sha256 })
})

it('refuses a wrong recipient before reading source data and a wrong source host before capture', async () => {
  const { host, request } = fixture()
  await expect(
    deliverWorkspaceFile(host, { ...request, recipientRuntimeId: 'other' })
  ).rejects.toThrow('not the selected recipient')
  expect(host.captureOwner).not.toHaveBeenCalled()
  await expect(
    deliverWorkspaceFile(host, { ...request, expectedSourceHostId: 'local' })
  ).rejects.toThrow('not on the requested source host')
  expect(host.captureSource).not.toHaveBeenCalled()
})

it('preserves a competing file and refuses an unexpected digest without writing a destination', async () => {
  const { host, request, destination } = fixture()
  await expect(
    deliverWorkspaceFile(host, { ...request, expectedSha256: '0'.repeat(64) })
  ).rejects.toThrow('does not match')
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(destination, Buffer.from([1, 2, 3, 4]))
  await expect(deliverWorkspaceFile(host, request)).rejects.toThrow('different bytes')
  expect(await readFile(destination)).toEqual(Buffer.from([1, 2, 3, 4]))
})

it.skipIf(process.platform === 'win32')(
  'refuses a destination symlink without changing its target',
  async () => {
    const { host, request, destination, bytes } = fixture()
    const target = join(root, 'existing.pdf')
    await writeFile(target, bytes)
    await symlink(target, destination)
    await expect(deliverWorkspaceFile(host, request)).rejects.toThrow('regular files')
    expect(await readFile(target)).toEqual(bytes)
  }
)

it('refuses changed source ownership or cancellation before materializing the captured file', async () => {
  const { host, request, destination, assertOwner } = fixture()
  assertOwner.mockRejectedValueOnce(new Error('Workspace changed'))
  await expect(deliverWorkspaceFile(host, request)).rejects.toThrow('Workspace changed')
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  const abort = new AbortController()
  abort.abort()
  await expect(deliverWorkspaceFile(host, request, abort.signal)).rejects.toThrow()
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects traversal in desktop names before source capture', async () => {
  const { host, request } = fixture()
  await expect(
    deliverWorkspaceFile(host, {
      ...request,
      destination: { kind: 'desktop', name: '../elsewhere' }
    })
  ).rejects.toThrow('portable file name')
  expect(host.captureSource).not.toHaveBeenCalled()
})
