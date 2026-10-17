import { randomUUID } from 'node:crypto'
import type { NativeChatTranscriptPageArgs } from '../../shared/native-chat-transcript-page'
import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { FileRangeReadUnsupportedError } from '../providers/filesystem-provider-contract'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority
} from '../ssh/ssh-provider-authority'
import { resolveSessionFilePath } from './session-file-resolver'
import { toHostReadableTranscriptPath } from './host-readable-transcript-path'
import {
  closeTranscriptHandle,
  wslGatedOpen,
  wslGatedRead,
  wslGatedStat
} from './wsl-transcript-fs-access'

const LOCAL_TRANSCRIPT_SOURCE_EPOCH = randomUUID()

export type TranscriptPageSource = {
  filePath: string
  sourceEpoch: string
  stat: () => Promise<{ size: number; identity: string; modifiedAt: number | null }>
  read: (position: number, length: number) => Promise<Buffer>
  close: () => Promise<void>
}

export async function openTranscriptPageSource(
  args: NativeChatTranscriptPageArgs,
  signal?: AbortSignal
): Promise<TranscriptPageSource | null> {
  signal?.throwIfAborted()
  if (args.connectionId) {
    const provider = requireSshFilesystemProvider(args.connectionId)
    const authority = getSshProviderAuthority(args.connectionId)
    const filePath = args.cursor?.filePath ?? args.transcriptPath
    if (!filePath) {
      throw new Error('The SSH session has no authoritative transcript path on its owning host.')
    }
    if (!provider.readFileRange || !(await provider.supportsFileRangeRead?.({ signal }))) {
      throw new FileRangeReadUnsupportedError('Update the SSH relay to read complete transcripts.')
    }
    const assertCurrent = (): void => {
      signal?.throwIfAborted()
      if (!isCurrentSshProviderAuthority(authority)) {
        throw new Error('Transcript source connection changed. Retry capture on its owning host.')
      }
    }
    return {
      filePath,
      sourceEpoch: authority.providerEpoch,
      stat: async () => {
        assertCurrent()
        const stat = await provider.stat(filePath)
        assertCurrent()
        if (stat.type !== 'file') {
          throw new Error('The transcript source is not a file.')
        }
        return {
          size: stat.size,
          identity: fileIdentity(stat),
          modifiedAt: stat.mtimeMs ?? stat.mtime ?? null
        }
      },
      read: async (position, length) => {
        assertCurrent()
        const result = await provider.readFileRange!(filePath, position, length, { signal })
        assertCurrent()
        return result.bytes
      },
      close: async () => {}
    }
  }
  const filePath =
    args.cursor?.filePath ??
    (args.transcriptPath
      ? await toHostReadableTranscriptPath(args.transcriptPath, { signal })
      : await resolveSessionFilePath(args.agent, args.sessionId, {}, signal))
  if (!filePath) {
    return null
  }
  const handle = await wslGatedOpen(filePath, 'exact', signal)
  return {
    filePath,
    sourceEpoch: LOCAL_TRANSCRIPT_SOURCE_EPOCH,
    stat: async () => {
      signal?.throwIfAborted()
      const stat = await wslGatedStat(filePath, 'exact', signal)
      if (!stat.isFile()) {
        throw new Error('The transcript source is not a file.')
      }
      return { size: stat.size, identity: fileIdentity(stat), modifiedAt: stat.mtimeMs }
    },
    read: async (position, length) => {
      signal?.throwIfAborted()
      if (length > MAX_FILE_RANGE_READ_BYTES) {
        throw new Error('Transcript range exceeds the host read limit.')
      }
      const buffer = Buffer.allocUnsafe(length)
      let filled = 0
      while (filled < length) {
        signal?.throwIfAborted()
        const { bytesRead } = await wslGatedRead(
          handle,
          filePath,
          buffer,
          filled,
          length - filled,
          position + filled,
          'exact',
          signal
        )
        if (bytesRead === 0) {
          break
        }
        filled += bytesRead
      }
      return buffer.subarray(0, filled)
    },
    close: () => closeTranscriptHandle(handle, filePath)
  }
}

function fileIdentity(stat: {
  dev?: number
  ino?: number
  size: number
  mtimeMs?: number
  mtime?: number | Date
}): string {
  const modifiedAt =
    stat.mtimeMs ?? (stat.mtime instanceof Date ? stat.mtime.getTime() : stat.mtime) ?? 0
  // Older relays omit inode identity; require an unchanged snapshot on those hosts.
  return stat.dev !== undefined && stat.ino !== undefined
    ? `${stat.dev}:${stat.ino}`
    : `${stat.size}:${modifiedAt}`
}
