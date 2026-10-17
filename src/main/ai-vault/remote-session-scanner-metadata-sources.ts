import type { AiVaultSession } from '../../shared/ai-vault-types'
import { joinRemotePath, remoteBasename, remoteDirname } from '../ssh/ssh-remote-platform'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { isMissingRemoteSessionPathError } from './remote-session-file-stat'
import type {
  RemoteParserOptions,
  RemoteScannerContext,
  RemoteSessionSource
} from './remote-session-scanner-types'
import { parseRovoSessionContent } from './session-scanner-graph-parsers'
import { parseGrokSessionContent } from './session-scanner-grok-parser'
import type { FileWithMtime } from './session-scanner-types'

type MetadataContentParser = (
  file: FileWithMtime,
  metadataContent: string,
  siblingContent: string | null,
  platform: NodeJS.Platform,
  options: RemoteParserOptions,
  signal?: AbortSignal
) => Promise<AiVaultSession | null> | AiVaultSession | null

export function remoteGrokSource(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform,
  grokHome = joinRemotePath(hostPlatform, remoteHome, '.grok')
): RemoteSessionSource {
  return metadataSource({
    agent: 'grok',
    rootDir: joinRemotePath(hostPlatform, grokHome, 'sessions'),
    hostPlatform,
    metadataName: 'summary.json',
    siblingName: 'chat_history.jsonl',
    parseContent: parseGrokSessionContent
  })
}

export function remoteRovoSource(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform,
  rovoSessionsDir = joinRemotePath(hostPlatform, remoteHome, '.rovodev', 'sessions')
): RemoteSessionSource {
  return metadataSource({
    agent: 'rovo',
    rootDir: rovoSessionsDir,
    hostPlatform,
    metadataName: 'metadata.json',
    siblingName: 'session_context.json',
    parseContent: parseRovoSessionContent
  })
}

function metadataSource(args: {
  agent: 'grok' | 'rovo'
  rootDir: string
  hostPlatform: RemoteHostPlatform
  metadataName: string
  siblingName: string
  parseContent: MetadataContentParser
}): RemoteSessionSource {
  const siblingPath = (filePath: string): string =>
    joinRemotePath(args.hostPlatform, remoteDirname(filePath, args.hostPlatform), args.siblingName)
  return {
    agent: args.agent,
    rootDir: args.rootDir,
    extensions: ['.json'],
    filePredicate: (filePath) => remoteBasename(filePath, args.hostPlatform) === args.metadataName,
    contentDependencyPath: siblingPath,
    parse: async (file, metadataContent, context) => {
      const siblingContent = await readMetadataSibling(siblingPath(file.path), context)
      const session = await args.parseContent(
        file,
        metadataContent,
        siblingContent,
        context.hostPlatform.os,
        {
          executionHostId: context.executionHostId,
          executionHostPlatform: context.hostPlatform.os
        },
        context.signal
      )
      throwIfAiVaultScanCancelled(context.signal)
      return session
    }
  }
}

async function readMetadataSibling(
  filePath: string,
  context: RemoteScannerContext
): Promise<string | null> {
  try {
    throwIfAiVaultScanCancelled(context.signal)
    const read = await context.provider.readFile(filePath)
    throwIfAiVaultScanCancelled(context.signal)
    if (read.isBinary) {
      throw new Error(`Session transcript is binary: ${filePath}`)
    }
    return read.content
  } catch (error) {
    throwIfAiVaultScanCancelled(context.signal)
    // Metadata can precede the first turn; other host failures must remain visible.
    if (isMissingRemoteSessionPathError(error)) {
      return null
    }
    throw error
  }
}
