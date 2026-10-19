import type { HandlerGroup } from './handler-group-manifest'

// Why split out: the Conversations sidebar commands (folders, and sessions managing sessions)
// change together, and handler-group-manifest.ts stays readable at a glance.
export const SESSION_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'session-prepare',
    keys: ['session prepare'],
    load: async () => (await import('./handlers/session-prepare.js')).SESSION_PREPARE_HANDLERS
  },
  {
    name: 'session-launch',
    keys: ['session launch', 'session launch-inspect'],
    load: async () => (await import('./handlers/session-launch.js')).SESSION_LAUNCH_HANDLERS
  },
  {
    name: 'session-projects',
    keys: ['folder project', 'folder projects', 'folder project-suggest', 'folder project-create'],
    load: async () => (await import('./handlers/session-projects.js')).SESSION_PROJECT_HANDLERS
  },
  {
    name: 'session-questions',
    keys: ['session questions'],
    load: async () => (await import('./handlers/session-questions.js')).SESSION_QUESTIONS_HANDLERS
  },
  {
    name: 'session-folders',
    keys: [
      'folder list',
      'folder create',
      'folder move',
      'folder rename',
      'folder color',
      'folder delete',
      'session move',
      'session archive',
      'session delete'
    ],
    load: async () => (await import('./handlers/session-folders.js')).SESSION_FOLDER_HANDLERS
  },
  {
    name: 'session-manage',
    keys: [
      'session list',
      'session continue',
      'session ask',
      'session answer',
      'session stop',
      'session restart',
      'session rename',
      'session conflicts',
      'session tidy',
      'session show'
    ],
    load: async () => (await import('./handlers/session-manage.js')).SESSION_MANAGE_HANDLERS
  },
  {
    name: 'session-organize',
    keys: ['session tag', 'session hide', 'session unhide', 'session snooze', 'session organize'],
    load: async () => (await import('./handlers/session-organize.js')).SESSION_ORGANIZE_HANDLERS
  },
  {
    name: 'session-history',
    keys: ['session history', 'session actions'],
    load: async () => (await import('./handlers/session-history.js')).SESSION_HISTORY_HANDLERS
  },
  {
    name: 'session-owner',
    keys: ['session find-owner', 'session assign'],
    load: async () => (await import('./handlers/session-owner.js')).SESSION_OWNER_HANDLERS
  },
  {
    name: 'session-hosts',
    keys: ['session hosts'],
    load: async () => (await import('./handlers/session-hosts.js')).SESSION_HOSTS_HANDLERS
  },
  {
    name: 'session-frame-log',
    keys: ['session frame-log', 'session sidebar-counts'],
    load: async () => (await import('./handlers/session-frame-log.js')).SESSION_FRAME_LOG_HANDLERS
  },
  {
    name: 'session-ledger',
    keys: ['session ledger'],
    load: async () => (await import('./handlers/session-ledger.js')).SESSION_LEDGER_HANDLERS
  },
  {
    name: 'session-relocate',
    keys: ['session relocate'],
    load: async () => (await import('./handlers/session-relocate.js')).SESSION_RELOCATE_HANDLERS
  },
  {
    name: 'session-transfer',
    keys: ['session handoff', 'session consolidate'],
    load: async () => (await import('./handlers/session-transfer.js')).SESSION_TRANSFER_HANDLERS
  },
  {
    // Answers reaching sessions: the hook-first delivery pilot's report.
    name: 'answers',
    keys: ['answers pilot-report'],
    load: async () => (await import('./handlers/answers.js')).ANSWERS_HANDLERS
  }
]
