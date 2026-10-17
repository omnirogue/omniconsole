/**
 * The `omni session launch` commands `omni host list` and its `--capacity` view recommend: the
 * `--host` flag that names one computer, and a launch line with a placeholder brief.
 */

import type { CapacityProvider } from '../shared/provider-account-capacity'
import { quoteCliCommandArgument } from './shell-command-quote'

// Why: `session launch --host` reads these words itself (local aliases, `auto`, and the explicit
// `ssh:`/`runtime:` forms), so a name spelled like one of them must fall back to its exact id.
const RESERVED_LAUNCH_HOST_NAME =
  /^(local|this computer|this mac|this machine|auto|ssh:.*|runtime:.*)$/i

/** The `--host` value for one computer: its name when unique and not a reserved word, else its id. */
export function launchHostValue(name: string, unique: boolean, exactSelector: string): string {
  const byName = unique && name.trim().length > 0 && !RESERVED_LAUNCH_HOST_NAME.test(name.trim())
  return byName ? name : exactSelector
}

export function launchHostFlag(name: string, unique: boolean, exactSelector: string): string {
  return `--host ${quoteCliCommandArgument(launchHostValue(name, unique, exactSelector))}`
}

export function capacityLaunchCommand(args: {
  provider: CapacityProvider
  model: string | null
  /** `--project`: the command picks the computer (and with `hostFlag`, only that one). */
  projectKey: string | null
  hostFlag: string | null
  /** A paired or SSH computer without `--project` needs a workspace there. */
  worktreePlaceholder: boolean
}): string {
  return [
    'omni session launch',
    `--provider ${args.provider}`,
    args.projectKey ? `--project ${quoteCliCommandArgument(args.projectKey)}` : null,
    args.hostFlag,
    args.worktreePlaceholder ? '--worktree <selector>' : null,
    args.model ? `--model ${quoteCliCommandArgument(args.model)}` : null,
    '--prompt-file <brief.md>',
    '--json'
  ]
    .filter((part): part is string => part !== null)
    .join(' ')
}
