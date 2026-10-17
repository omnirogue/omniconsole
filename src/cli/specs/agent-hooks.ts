import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_HOOK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'hooks', 'prepare-codex'],
    summary: 'Repair OmniConsole-managed Codex hook trust before a shell launch',
    usage: 'omni agent hooks prepare-codex',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['agent', 'hooks', 'status'],
    summary: 'Show whether OmniConsole-managed agent status hooks are enabled',
    usage: 'omni agent hooks status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['omni agent hooks status', 'omni agent hooks status --json']
  },
  {
    path: ['agent', 'hooks', 'off'],
    summary: 'Disable OmniConsole-managed agent status hooks and remove local hook entries',
    usage: 'omni agent hooks off [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['omni agent hooks off']
  },
  {
    path: ['agent', 'hooks', 'on'],
    summary: 'Enable OmniConsole-managed agent status hooks',
    usage: 'omni agent hooks on [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['omni agent hooks on']
  }
]
