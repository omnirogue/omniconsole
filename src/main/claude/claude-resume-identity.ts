import { statSync } from 'node:fs'
import { dirname, basename, isAbsolute } from 'node:path'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'

/** True when Claude's own session file exists at this absolute path. */
export function claudeSessionFileExists(path: string | undefined): boolean {
  if (!path || !isAbsolute(path)) {
    return false
  }
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function claudeTranscriptExists(
  identity: AgentProviderSessionMetadata | undefined
): boolean {
  return claudeSessionFileExists(identity?.transcriptPath)
}

export function claudeResumeConfigDir(identity: AgentProviderSessionMetadata): string | undefined {
  const transcript = identity.transcriptPath
  if (!transcript || !isAbsolute(transcript)) {
    return undefined
  }
  const projects = dirname(dirname(transcript))
  return basename(projects) === 'projects' ? dirname(projects) : undefined
}

export function retainVerifiedClaudeIdentity(
  next: AgentProviderSessionMetadata,
  previous?: AgentProviderSessionMetadata
): AgentProviderSessionMetadata {
  if (!next.transcriptPath && next.id === previous?.id) {
    next = { ...previous, ...next }
  }
  const prior = previous && claudeTranscriptExists(previous) ? previous : previous?.verifiedFallback
  const fallback = prior && claudeTranscriptExists(prior) ? prior : next.verifiedFallback
  return {
    ...next,
    ...(fallback?.transcriptPath && fallback.id !== next.id
      ? {
          verifiedFallback: {
            key: fallback.key,
            id: fallback.id,
            transcriptPath: fallback.transcriptPath
          }
        }
      : {})
  }
}

/** Legacy identities without a path stay compatible; an explicitly missing transcript never launches. */
export function selectClaudeResumeIdentity(
  identity: AgentProviderSessionMetadata
): AgentProviderSessionMetadata | null {
  if (claudeTranscriptExists(identity)) {
    return identity
  }
  if (claudeTranscriptExists(identity.verifiedFallback)) {
    return identity.verifiedFallback!
  }
  return identity.transcriptPath ? null : identity
}
