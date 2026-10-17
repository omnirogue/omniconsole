import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import type { FollowUpHostIo } from '../../shared/session-follow-up-delivery-contract'
import { resolveWorkspaceOutputPath } from '../../shared/session-follow-up-deliverables'
import { captureHandoffAttachment } from '../backoffice/handoff-attachment-capture'
import {
  createHandoffAttachmentIo,
  type HandoffAttachmentIo
} from '../backoffice/handoff-attachment-source'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getSshConnectionGeneration } from '../ssh/ssh-connection-generation'
import { assertFleetSourcePath } from './conversation-fleet-source-io'

/** One immediate capture retains its SSH provider and never gains continuation ownership. */
export async function createSshSessionHandoffIo(
  workspacePath: string,
  connectionId: string,
  assertOwner: () => void
) {
  if (!connectionId.trim()) {
    throw new Error('Choose a valid SSH source connection.')
  }
  const provider = requireSshFilesystemProvider(connectionId)
  const generation = getSshConnectionGeneration(connectionId)
  const assertCurrent = (): void => {
    assertOwner()
    if (
      provider !== requireSshFilesystemProvider(connectionId) ||
      generation !== getSshConnectionGeneration(connectionId)
    ) {
      throw new Error('The source SSH computer changed. Prepare the handoff again.')
    }
  }
  const owned = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent()
    try {
      return await operation()
    } finally {
      assertCurrent()
    }
  }
  assertCurrent()
  const source = createHandoffAttachmentIo(connectionId)
  const io: HandoffAttachmentIo = {
    realpath: (path) => owned(() => source.realpath(path)),
    lstat: (path) => owned(() => source.lstat(path)),
    readExact: (path, maxBytes, expected) =>
      owned(() => source.readExact(path, maxBytes, expected)),
    readNames: (path) => owned(() => source.readNames(path))
  }
  const api = isWindowsAbsolutePathLike(workspacePath) ? win32 : posix
  if (!api.isAbsolute(workspacePath)) {
    throw new Error('The source workspace must be an absolute path on its SSH computer.')
  }
  const root = await io.realpath(workspacePath)
  if (
    (await io.lstat(root)).type !== 'directory' ||
    api.relative(root, await io.realpath(root)) !== ''
  ) {
    throw new Error('The source SSH workspace changed. Prepare the handoff again.')
  }
  const sourcePath = async (path: string): Promise<string> => {
    const resolved = resolveWorkspaceOutputPath(workspacePath, path)
    if (!resolved) {
      throw new Error('A selected handoff file or folder is outside the execution workspace.')
    }
    const relative = api.relative(workspacePath, resolved)
    return assertFleetSourcePath(io, root, relative)
  }
  const followUpIo: FollowUpHostIo = {
    exists: async (path) => {
      try {
        await sourcePath(path)
        return true
      } catch (error) {
        if (isENOENT(error)) {
          return false
        }
        throw error
      }
    },
    size: async (path) => (await io.lstat(await sourcePath(path))).size,
    readExact: async (path) => captureHandoffAttachment(await sourcePath(path), io, true)
  }
  const verifyBytes = async (destination: string, bytes: Buffer): Promise<void> => {
    const stat = await io.lstat(destination)
    if (stat.type !== 'file') {
      throw new Error('The chosen handoff destination is not a regular file.')
    }
    if (stat.size !== bytes.length) {
      throw new Error('The chosen handoff destination changed; select a new path or remove it.')
    }
    const current = await io.readExact(destination, bytes.length, stat)
    if (!current.equals(bytes)) {
      throw new Error('The chosen handoff destination changed; select a new path or remove it.')
    }
  }
  const materialize = async (destination: string, bytes: Buffer): Promise<void> => {
    const parent = api.dirname(destination)
    const checkParent = async (): Promise<void> => {
      if (api.relative(parent, await io.realpath(parent)) !== '') {
        throw new Error('The chosen handoff folder changed or resolves through a symbolic link.')
      }
    }
    await checkParent()
    const existing = await io.lstat(destination).catch((error: unknown) => {
      if (isENOENT(error)) {
        return null
      }
      throw error
    })
    if (existing) {
      await verifyBytes(destination, bytes)
      await checkParent()
      return
    }
    await checkParent()
    // SSH binary writes reserve the destination exclusively; text writes can overwrite it.
    await owned(() => provider.writeFileBase64(destination, bytes.toString('base64')))
    await checkParent()
    await verifyBytes(destination, bytes)
  }
  const destinationHoldsOtherBytes = async (
    destination: string,
    bytes: Buffer
  ): Promise<boolean> => {
    const existing = await io.lstat(destination).catch((error: unknown) => {
      if (isENOENT(error)) {
        return null
      }
      throw error
    })
    return (
      !!existing &&
      (await verifyBytes(destination, bytes).then(
        () => false,
        () => true
      ))
    )
  }
  return {
    root,
    io: followUpIo,
    path: api,
    realpath: io.realpath,
    materialize,
    destinationHoldsOtherBytes,
    assertCurrent,
    owned
  }
}
