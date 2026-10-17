import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  buildOpenCodeLaunchConfig,
  templateInstructionsFileStem
} from '../../shared/local-ollama-launch'
import { AGENT_TEMPLATE_DEFAULT_ID, type AgentTemplate } from '../../shared/agent-templates'
import { toLinuxPath } from '../../shared/wsl-paths'

/**
 * OpenCode merges `OPENCODE_CONFIG_CONTENT` on top of every other config source, so the
 * launch never displaces a user's own `OPENCODE_CONFIG`. The template text goes to a file
 * under userData that the config names in `instructions`, so OpenCode appends it after the
 * project and global rules instead of replacing its system prompt. OpenCode re-reads the
 * file at every step and a session (daemon-owned PTYs outlive the app) can run for weeks, so
 * files are immutable and content-addressed: one file per distinct text, never rewritten,
 * never pruned. A template edit yields a new file; running sessions keep theirs.
 */
export type PreparedOpenCodeLaunch = {
  env: { OPENCODE_CONFIG_CONTENT: string }
  /** The file the template was written to, if the template has text. */
  instructionsPath?: string
}

export function prepareOpenCodeLaunchConfig(args: {
  model: string
  template: AgentTemplate
  baseUrl?: string
  contextLength?: number
  /** Where template files live; one immutable file per distinct template text. */
  instructionsDir: string
  platform?: NodeJS.Platform
}): PreparedOpenCodeLaunch {
  const hasText = args.template.id !== AGENT_TEMPLATE_DEFAULT_ID && !!args.template.instructions
  let instructionsPath: string | undefined
  const instructionsPaths: string[] = []
  if (hasText) {
    mkdirSync(args.instructionsDir, { recursive: true })
    const text = `${args.template.instructions!.trim()}\n`
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 16)
    instructionsPath = join(
      args.instructionsDir,
      `${templateInstructionsFileStem(args.template)}-${digest}.md`
    )
    // Why: same text, same file; an existing file is by construction identical.
    if (!existsSync(instructionsPath)) {
      writeFileAtomically(instructionsPath, text)
    }
    instructionsPaths.push(instructionsPath)
    // Why: a WSL launch reads the same file through the automount; OpenCode skips a path it cannot find.
    if ((args.platform ?? process.platform) === 'win32') {
      const mounted = toLinuxPath(instructionsPath)
      if (mounted !== instructionsPath) {
        instructionsPaths.push(mounted)
      }
    }
  }
  const config = buildOpenCodeLaunchConfig({ ...args, instructionsPaths })
  return {
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    ...(instructionsPath ? { instructionsPath } : {})
  }
}
