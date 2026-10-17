import { resolveKimiTranscriptSource } from '../native-chat/kimi-transcript-source'
import { joinRemotePath, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { remoteSessionContentLines } from './remote-session-content-lines'
import { isMissingRemoteSessionPathError } from './remote-session-file-stat'
import type { RemoteScannerContext, RemoteSessionSource } from './remote-session-scanner-types'
import { parseKimiSessionContent } from './session-scanner-kimi-parser'
import { extractString, parseJsonObject } from './session-scanner-values'

export function remoteKimiSource(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform,
  kimiHome = joinRemotePath(hostPlatform, remoteHome, '.kimi-code')
): RemoteSessionSource {
  const rootDir = joinRemotePath(hostPlatform, kimiHome, 'sessions')
  const normalizedRoot = rootDir.replace(/\\/g, '/')
  const indexPath = joinRemotePath(hostPlatform, kimiHome, 'session_index.jsonl')
  return {
    agent: 'kimi',
    rootDir,
    extensions: ['.json'],
    filePredicate: (path) => {
      const normalizedPath = path.replace(/\\/g, '/')
      const relative = normalizedPath.slice(normalizedRoot.length + 1)
      return (
        normalizedPath.startsWith(`${normalizedRoot}/`) &&
        /^wd_[^/]+\/session_[^/]+\/state\.json$/.test(relative)
      )
    },
    directoryPredicate: (name, depth) =>
      (depth === 0 && name.startsWith('wd_')) || (depth === 1 && name.startsWith('session_')),
    parse: async (file, content, context) => {
      throwIfAiVaultScanCancelled(context.signal)
      const sessionId = file.path.replace(/\\/g, '/').split('/').at(-2) ?? ''
      const stateRecord = parseJsonObject(content)
      if (!stateRecord) {
        throw new Error('Kimi session metadata must be a valid JSON object.')
      }
      const source = await resolveKimiTranscriptSource(
        { transcriptPath: file.path, sessionId },
        { readFile: async () => Buffer.from(content, 'utf8'), signal: context.signal }
      )
      throwIfAiVaultScanCancelled(context.signal)
      const wireContent = await readOptionalRemoteKimiFile(source.filePath, context)
      const workDirs = await remoteKimiWorkDirs(indexPath, context)
      throwIfAiVaultScanCancelled(context.signal)
      return parseKimiSessionContent({
        file,
        sessionId,
        stateRecord,
        cwd: workDirs.get(sessionId) ?? null,
        wireLines: remoteSessionContentLines(wireContent ?? '', context.signal),
        platform: context.hostPlatform.os,
        options: {
          executionHostId: context.executionHostId,
          executionHostPlatform: context.hostPlatform.os
        }
      })
    }
  }
}

async function readOptionalRemoteKimiFile(
  path: string,
  context: RemoteScannerContext
): Promise<string | null> {
  try {
    throwIfAiVaultScanCancelled(context.signal)
    const file = await context.provider.readFile(path)
    throwIfAiVaultScanCancelled(context.signal)
    if (file.isBinary) {
      throw new Error(`Kimi session data is not readable text: ${path}`)
    }
    return file.content
  } catch (error) {
    throwIfAiVaultScanCancelled(context.signal)
    if (!isMissingRemoteSessionPathError(error)) {
      throw error
    }
    return null
  }
}

function remoteKimiWorkDirs(
  indexPath: string,
  context: RemoteScannerContext
): Promise<Map<string, string>> {
  const key = `kimi-work-dir:${context.executionHostId}:${indexPath}`
  const cached = context.titleCaches.get(key)
  if (cached) {
    return cached
  }
  const pending = readRemoteKimiWorkDirs(indexPath, context)
  context.titleCaches.set(key, pending)
  return pending
}

async function readRemoteKimiWorkDirs(
  indexPath: string,
  context: RemoteScannerContext
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const content = await readOptionalRemoteKimiFile(indexPath, context)
  for await (const line of remoteSessionContentLines(content ?? '', context.signal)) {
    const record = parseJsonObject(line)
    const sessionId = extractString(record?.sessionId)
    const workDir = extractString(record?.workDir)
    if (sessionId && workDir) {
      map.set(sessionId, workDir)
    }
  }
  return map
}
