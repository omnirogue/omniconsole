import { setTimeout as delay } from 'node:timers/promises'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { buildClaudeResumeLaunchCommand } from '../../shared/agent-resume-launch-command'
import { resolveStartupShell } from '../../shared/tui-agent-startup-shell'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import {
  claudeResumeConfigDir,
  claudeTranscriptExists,
  selectClaudeResumeIdentity
} from './claude-resume-identity'
import { restoreClaudeThreadMemorySettings } from './claude-thread-memory'

export class ClaudeResumeTranscriptMissingError extends Error {
  constructor() {
    super('Claude resume transcript is missing and no verified fallback is available.')
  }
}

/** Runs on the execution host before either PTY spawn path chooses credentials. */
export async function prepareClaudeResumeLaunch(
  args: {
    command?: string
    env?: Record<string, string>
    resumeProviderSession?: AgentProviderSessionMetadata
  },
  shellOverride?: string
): Promise<void> {
  const candidate = args.resumeProviderSession
  if (!candidate) {
    return
  }
  if (candidate.transcriptPath && !claudeTranscriptExists(candidate)) {
    // Claude can emit SessionStart just before creating its transcript.
    await delay(250)
  }
  const selected = selectClaudeResumeIdentity(candidate)
  if (!selected) {
    throw new ClaudeResumeTranscriptMissingError()
  }
  if (selected.id !== candidate.id) {
    if (!args.command) {
      throw new Error('Claude fallback resume requires a launch command.')
    }
    const shell = resolveStartupShell(
      process.platform,
      /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shellOverride ?? '') ? 'cmd' : undefined
    )
    const command = buildClaudeResumeLaunchCommand(args.command, ['--resume', selected.id], shell)
    if (command.includes(candidate.id)) {
      throw new Error('Cannot safely replace the missing Claude resume selector.')
    }
    args.command = command
  }
  const home = claudeResumeConfigDir(selected)
  if (home) {
    const env = { ...args.env }
    delete env.CLAUDE_CONFIG_DIR
    delete env.ORCA_CLAUDE_CONFIG_DIR
    args.env = { ...env, ...claudeConfigDirEnvPatch(home) }
  }
  args.resumeProviderSession = selected
}

export async function prepareLocalClaudeResumeLaunch(
  args: Parameters<typeof prepareClaudeResumeLaunch>[0] & { connectionId?: string | null },
  context: {
    isClaudeLaunch: boolean
    preAdoptedStablePane: unknown
    expectedWslDistro: string | null
    terminalRuntimeOptions: { shellOverride?: string }
  }
): Promise<void> {
  if (
    context.isClaudeLaunch &&
    !context.preAdoptedStablePane &&
    !args.connectionId &&
    context.expectedWslDistro === null
  ) {
    restoreClaudeThreadMemorySettings(args.command)
    await prepareClaudeResumeLaunch(args, context.terminalRuntimeOptions.shellOverride)
  }
}
