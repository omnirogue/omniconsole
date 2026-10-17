import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const FILE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['file', 'deliver'],
    summary: 'Deliver a verified workspace file to an explicitly selected recipient computer',
    usage:
      'omni file deliver <path> --worktree <selector> --source-host local|ssh:<id> --recipient-runtime-id <uuid> (--desktop-name <name> | --destination <absolute-path>) [--sha256 <digest>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'path',
      'worktree',
      'source-host',
      'recipient-runtime-id',
      'desktop-name',
      'destination',
      'sha256'
    ],
    positionalArgs: ['path'],
    examples: [
      'omni file deliver outputs/report.pdf --worktree id:<workspace> --source-host ssh:<worker> --recipient-runtime-id <recipient-status-uuid> --desktop-name report.pdf --json'
    ],
    notes: [
      'Connect to the intended recipient runtime and read its ID from omni status --json. That computer must own the selected local or SSH workspace. Desktop means that runtime computer’s OS desktop; it never means the worker’s desktop or an inferred phone/paired client destination.',
      'The source path must be relative to the workspace. Reuses exact source snapshots for one regular file up to 10 MiB, including binary files and folder workspaces. Symlinks and changed files refuse; there is no local fallback for SSH.',
      'The destination directory must already exist. Existing different files are never overwritten. Identical bytes return already-present with recipient path, size and SHA-256. Supply --sha256 to require a previously recorded source digest.',
      'After a timeout or lost reply, inspect the same destination or retry the same path and source digest. Do not choose a new name automatically. No server upload or public link is created.',
      'A headless recipient requires --destination with an explicit absolute path. Older runtimes refuse this command; do not fall back to writing on the worker.'
    ]
  },
  {
    path: ['file', 'open'],
    summary: 'Open a workspace file in the OmniConsole editor',
    usage: 'omni file open <path> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'worktree'],
    positionalArgs: ['path'],
    notes: [
      'The path may be relative to the selected worktree or an absolute path inside that worktree. When --worktree is omitted, local CLI calls infer the current OmniConsole worktree from cwd.'
    ],
    examples: [
      'omni file open src/App.tsx',
      'omni file open --path docs/readme.md --worktree active'
    ]
  },
  {
    path: ['file', 'diff'],
    summary: 'Open a workspace file diff in the OmniConsole editor',
    usage: 'omni file diff <path> [--staged] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'staged', 'worktree'],
    positionalArgs: ['path'],
    notes: [
      'Diffs default to unstaged changes. Pass --staged to open the staged source-control diff.',
      'The path may be relative to the selected worktree or an absolute path inside that worktree.'
    ],
    examples: [
      'omni file diff src/App.tsx',
      'omni file diff --path package.json --staged --worktree branch:feature'
    ]
  },
  {
    path: ['file', 'open-changed'],
    summary: 'Open all git-changed files for a workspace',
    usage: 'omni file open-changed [--mode edit|diff|both] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'mode', 'worktree'],
    notes: [
      'For v1, changed files come from git status for the selected worktree.',
      'The default mode is diff. Edit mode skips deleted files because there is no file to open.'
    ],
    examples: [
      'omni file open-changed',
      'omni file open-changed --mode both',
      'omni file open-changed --mode diff --worktree active'
    ]
  }
]
