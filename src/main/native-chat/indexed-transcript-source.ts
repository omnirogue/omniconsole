import { isAbsolute, win32 } from 'node:path'
import {
  AI_VAULT_AGENTS,
  isAiVaultScanCancelledError,
  type AiVaultAgent,
  type AiVaultListArgs,
  type AiVaultListResult
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'

export type IndexedTranscriptSource = {
  agent: AiVaultAgent
  sessionId: string
  filePath: string
}

export class TranscriptSourceIndexError extends Error {
  readonly code = 'TRANSCRIPT_SOURCE_INDEX_UNAVAILABLE'

  constructor(detail: string) {
    super(`Transcript source index unavailable: ${detail}`)
    this.name = 'TranscriptSourceIndexError'
  }
}

export function validateIndexedTranscriptIdentity(
  agent: unknown,
  sessionId: unknown
): { agent: AiVaultAgent; sessionId: string } {
  const canonicalAgent =
    typeof agent === 'string' ? (resolveNativeChatTranscriptAgent(agent) ?? agent) : null
  if (!canonicalAgent || !AI_VAULT_AGENTS.some((value) => value === canonicalAgent)) {
    throw new Error('Invalid transcript source agent')
  }
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    sessionId.length > 512 ||
    sessionId.trim() !== sessionId ||
    Array.from(sessionId).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    throw new Error('Invalid transcript source session ID')
  }
  return { agent: canonicalAgent as AiVaultAgent, sessionId }
}

export function findIndexedTranscriptSource(
  result: AiVaultListResult,
  agent: string,
  sessionId: string,
  executionHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): IndexedTranscriptSource | null {
  const identity = validateIndexedTranscriptIdentity(agent, sessionId)
  if (result.cancelled) {
    throw new TranscriptSourceIndexError('the owning host scan was cancelled')
  }
  const candidates = result.sessions.filter(
    (session) =>
      session.executionHostId === executionHostId &&
      session.agent === identity.agent &&
      session.sessionId === identity.sessionId
  )
  if (candidates.some((session) => !validIndexedPath(session.filePath))) {
    throw new TranscriptSourceIndexError('the matching session has no usable source path')
  }
  const paths = [...new Set(candidates.map((session) => session.filePath))]
  if (paths.length > 1) {
    throw Object.assign(
      new Error(`Ambiguous transcript source for ${identity.agent} session ${identity.sessionId}`),
      { code: 'TRANSCRIPT_SOURCE_AMBIGUOUS' }
    )
  }
  // A partial provider index cannot prove that another matching source is absent.
  const sourceIssue = result.issues.find(
    (issue) =>
      (issue.executionHostId === undefined || issue.executionHostId === executionHostId) &&
      issue.kind !== 'notice' &&
      (issue.agent === identity.agent || issue.kind === 'host' || issue.kind === 'scope')
  )
  if (sourceIssue) {
    throw new TranscriptSourceIndexError(
      `the owning host reported a ${sourceIssue.kind ?? 'source'} issue for ${identity.agent}`
    )
  }
  const filePath = paths[0]
  return filePath === undefined ? null : { ...identity, filePath }
}

type LocalTranscriptSourceSessionList = (
  args: AiVaultListArgs,
  options?: { signal?: AbortSignal }
) => Promise<AiVaultListResult>

export async function resolveIndexedTranscriptFilePath(
  agent: string,
  sessionId: string,
  options: { listSessions: LocalTranscriptSourceSessionList; signal?: AbortSignal }
): Promise<string | null> {
  validateIndexedTranscriptIdentity(agent, sessionId)
  const { signal } = options
  // Reuse the owning runtime's cached list; refresh a healthy miss once for new sessions.
  for (const force of [false, true]) {
    signal?.throwIfAborted()
    let result: AiVaultListResult
    try {
      result = await options.listSessions(
        { unlimited: true, ...(force ? { force: true } : {}) },
        { signal }
      )
    } catch (error) {
      signal?.throwIfAborted()
      if (isAiVaultScanCancelledError(error)) {
        throw error
      }
      throw new TranscriptSourceIndexError('the owning host session service did not answer')
    }
    signal?.throwIfAborted()
    const source = findIndexedTranscriptSource(result, agent, sessionId)
    if (source) {
      return source.filePath
    }
  }
  return null
}

function validIndexedPath(filePath: string): boolean {
  return (
    typeof filePath === 'string' &&
    filePath.trim().length > 0 &&
    filePath.length <= 32_768 &&
    (isAbsolute(filePath) || win32.isAbsolute(filePath)) &&
    !filePath.includes('\0')
  )
}
