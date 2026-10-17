import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const WORK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['work', 'bind'],
    summary:
      'Bind a Jira issue to the session that owns it, so a QA reply on it wakes that session',
    usage:
      'omni work bind --jira <KEY> [--pane <paneKey> | --session <ref> | --routine <name>] [--pr <n>[,<n>…]] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'jira', 'pane', 'session', 'routine', 'pr'],
    notes: [
      'With no --pane, --session or --routine it binds the calling pane. One session owns an issue; binding again replaces the owner.',
      '--routine marks an issue a routine already watches: OmniOS then creates no deliveries for it.',
      '--pr links those pull requests (their prototype cards) to the issue as well.'
    ],
    examples: [
      'omni work bind --jira OMR-93',
      'omni work bind --jira OMR-93 --session claude:5b7cfeb8-f58f-4b87-a739-1bfee2bbf8ea@local',
      'omni work bind --jira OMR-79 --routine omr-79-chatgpt-qa-watch'
    ]
  }
]
