import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { CaptureFleetSourceRequest } from '../../shared/conversation-fleet-source-snapshot'
import type {
  WorkspaceFileDeliveryRequest,
  WorkspaceFileDeliveryResult
} from '../../shared/workspace-file-delivery'
import { captureDirectoryRoot, checkRootedDirectory } from '../filesystem-directory-chain'
import { writeExclusiveFile } from '../filesystem-exclusive-file'
import { sanitizeLocalDownloadFilename } from '../local-download-filename'
import type { RuntimeFileTransferContext } from './browser-download-destination'
import { createFleetSourceIo } from './conversation-fleet-source-io'
import type { CapturedFleetSource } from './conversation-fleet-source-snapshot'

type FileDeliveryHost = {
  runtimeId: string
  desktopPath(): string
  captureOwner(worktree: string): Promise<Omit<RuntimeFileTransferContext, 'destination'>>
  captureSource(
    request: CaptureFleetSourceRequest,
    signal?: AbortSignal
  ): Promise<CapturedFleetSource>
}

/** Deliver the captured bytes to one explicit runtime; the worker's home is never a destination. */
export async function deliverWorkspaceFile(
  host: FileDeliveryHost,
  request: WorkspaceFileDeliveryRequest,
  signal?: AbortSignal
): Promise<WorkspaceFileDeliveryResult> {
  if (request.recipientRuntimeId !== host.runtimeId) {
    throw new Error('This is not the selected recipient runtime. No file was delivered here.')
  }
  signal?.throwIfAborted()
  const selection = request.destination
  const requestedPath =
    selection.kind === 'desktop' ? join(host.desktopPath(), selection.name) : selection.path
  const name = selection.kind === 'desktop' ? selection.name : basename(requestedPath)
  if (
    !isAbsolute(requestedPath) ||
    sanitizeLocalDownloadFilename(name) !== name ||
    name.includes('\u007f')
  ) {
    throw new Error('Choose an absolute destination with a single portable file name.')
  }
  const parent = await captureDirectoryRoot(dirname(requestedPath))
  const destination = join(parent.path, name)
  const owner = await host.captureOwner(request.worktree)
  if (
    owner.expectedExecutionHostId !== request.expectedSourceHostId ||
    (owner.expectedSshTargetId ? `ssh:${owner.expectedSshTargetId}` : 'local') !==
      request.expectedSourceHostId
  ) {
    throw new Error('The selected workspace is not on the requested source host.')
  }
  const captured = await host.captureSource(
    {
      worktree: `id:${owner.worktreeId}`,
      paths: [request.sourcePath],
      includeDirtyTracked: false,
      expectedConnectionId: owner.expectedSshTargetId ?? null
    },
    signal
  )
  await owner.assertOwner()
  const file = captured.manifest.files[0]
  const bytes = file ? captured.bytes.get(file.id) : undefined
  if (
    captured.manifest.files.length !== 1 ||
    !file ||
    !bytes ||
    file.targetPath !== request.sourcePath ||
    captured.manifest.source.connectionId !== (owner.expectedSshTargetId ?? null) ||
    file.size !== bytes.length ||
    file.sha256 !== createHash('sha256').update(bytes).digest('hex') ||
    (request.expectedSha256 !== undefined && file.sha256 !== request.expectedSha256)
  ) {
    throw new Error('The captured file does not match the requested source bytes.')
  }
  const validateDestination = async () => {
    signal?.throwIfAborted()
    await owner.assertOwner()
    await checkRootedDirectory(parent, parent.path)
  }
  await validateDestination()
  let disposition: WorkspaceFileDeliveryResult['disposition'] = 'delivered'
  try {
    await writeExclusiveFile(destination, bytes, { validateDestinationParent: validateDestination })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    disposition = 'already-present'
  }
  // Reuse the exact reader so a symlink, competing edit or partial destination is never a receipt.
  const delivered = await createFleetSourceIo().readExact(destination, bytes.length)
  if (!delivered.equals(bytes)) {
    throw new Error(
      'The destination contains different bytes. Choose another path; nothing was overwritten.'
    )
  }
  await validateDestination()
  return {
    disposition,
    source: {
      hostId: request.expectedSourceHostId,
      worktreeId: owner.worktreeId,
      path: file.targetPath
    },
    recipient: { runtimeId: host.runtimeId, hostname: hostname(), path: destination },
    size: file.size,
    sha256: file.sha256
  }
}
