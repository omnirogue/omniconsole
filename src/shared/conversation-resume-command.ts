/**
 * The one command that resumes a found Claude or Codex conversation by hand: the sidebar's "Copy
 * resume command" and `omni session resume` refusals both print it. It pins the profile the
 * transcript lives under and quotes every value for the target shell; it names the host it must
 * run on, since a conversation resumes only where its transcript is.
 */

import { buildAiVaultResumeCommand } from './ai-vault-resume-command'
import { sessionManageHostKey } from './session-manage-query'
import type { SessionReferenceAgent } from './session-reference'

export type ConversationProfile = {
  variable: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'
  path: string
  /** `~/.claude` or `~/.codex`: the provider's own default, which needs no variable. */
  isDefault: boolean
}

export type ConversationResumeCommand = {
  command: string
  /** The machine it must run on; null for this computer. */
  hostLabel: string | null
  profile: ConversationProfile | null
}

/**
 * The provider home a transcript lives under: `<config dir>/projects/<slug>/<id>.jsonl` for Claude,
 * `<CODEX_HOME>/sessions/…/rollout-…-<id>.jsonl` for Codex; null for any other shape.
 */
export function conversationProfileOf(
  agent: SessionReferenceAgent,
  transcriptPath: string
): ConversationProfile | null {
  const separator = transcriptPath.includes('/') ? '/' : '\\'
  const parts = transcriptPath.split(/[\\/]/)
  const marker = agent === 'claude' ? 'projects' : 'sessions'
  const index = parts.lastIndexOf(marker)
  if (index < 1 || (agent === 'claude' && index !== parts.length - 3)) {
    return null
  }
  return {
    variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
    path: parts.slice(0, index).join(separator),
    isDefault: parts[index - 1] === (agent === 'claude' ? '.claude' : '.codex')
  }
}

export function buildConversationResumeCommand(args: {
  agent: SessionReferenceAgent
  sessionId: string
  cwd: string | null
  transcriptPath: string
  executionHostId: string
  hostLabel: string
  /** The shell grammar of the host it runs on. */
  platform: NodeJS.Platform
}): ConversationResumeCommand {
  const profile = conversationProfileOf(args.agent, args.transcriptPath)
  const custom = profile && !profile.isDefault ? profile.path : null
  // Why clear on the default home: an inherited variable would resume under another account.
  const clearEnvNames = custom
    ? undefined
    : args.agent === 'codex'
      ? ['CODEX_HOME', 'ORCA_CODEX_HOME']
      : ['CLAUDE_CONFIG_DIR']
  const command = buildAiVaultResumeCommand({
    agent: args.agent,
    sessionId: args.sessionId,
    cwd: args.cwd,
    platform: args.platform,
    codexHome: args.agent === 'codex' ? custom : null,
    claudeConfigDir: args.agent === 'claude' ? custom : null,
    ...(clearEnvNames && profile ? { clearEnvNames } : {})
  })
  return {
    command,
    hostLabel: sessionManageHostKey(args.executionHostId) === 'local' ? null : args.hostLabel,
    profile
  }
}
