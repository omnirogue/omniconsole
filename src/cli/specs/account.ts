import { GLOBAL_FLAGS, type CommandSpec } from '../args'

// Why: the desktop "Add account" button is disabled when the UI drives a remote
// runtime (a headless server). These commands run the interactive agent login
// (`claude login` / `codex login`) in the caller's own terminal on the host and
// register the captured account with the local runtime, giving headless hosts a
// way to manage Claude and Codex accounts.
export const ACCOUNT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['account', 'add'],
    summary: 'Add a managed Claude or Codex account by signing in on this OmniConsole host',
    usage: 'omni account add [--agent claude|codex] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent'],
    notes: [
      'Runs the agent login (`claude login` / `codex login`) in this terminal, then registers the account with the local OmniConsole runtime.',
      'Codex uses device authorization so the browser can complete sign-in from a different machine.',
      'Sign in with the account you want to add (e.g. use a private/incognito browser window for a second account).',
      '--agent defaults to claude. Requires the OmniConsole runtime to be running on this machine.'
    ],
    examples: ['omni account add', 'omni account add --agent codex']
  },
  {
    path: ['account', 'list'],
    summary: 'List managed Claude and Codex accounts on this OmniConsole host',
    usage: 'omni account list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Lists the accounts on this machine. `--environment` / `--pairing-code` are rejected rather than ignored; run it on the host whose accounts you want to see.'
    ],
    examples: ['omni account list']
  },
  {
    path: ['account', 'usage'],
    summary: 'Probe live usage for one explicitly selected account on this host',
    usage: 'omni account usage --input-file <absolute-private-json> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'input-file'],
    notes: [
      '--input-file must be an absolute path to an owner-only JSON request file owned by the runtime user. The caller removes the file after the command completes.',
      'The version 1 request selects a provider and its exact configRoot, or an explicit Kimi token and baseUrl. Credentials belong only in the private file.',
      'Returns sanitized live usage without changing credentials or running a model. Missing or unsupported usage remains unavailable.',
      '`--environment` and `--pairing-code` are rejected; run this command on the execution host.'
    ],
    examples: ['omni account usage --input-file /private/tmp/selected-account.json --json']
  }
]
