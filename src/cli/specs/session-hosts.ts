import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const SESSION_HOSTS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'hosts'],
    summary: 'Show the other computers that run sessions in the sidebar, and what each can do',
    usage: 'omni session hosts [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['omni session hosts', 'omni session hosts --json'],
    notes: [
      "Read-only. One line per other computer (a paired OmniConsole runtime or an SSH host) that runs a session in the sidebar: ready (it carries out continue, ask, answer, stop and restart on its own sessions; an SSH relay that also advertises session-control.delivery.v1 takes this Mac's own automatic prompts through its admission), controls-off (it offers none this Mac understands), older (its OmniConsole has no session host control; controls are refused before anything is sent), unreachable (it could not be asked; its sessions are left alone and read unverifiable, never exited). Counts come from that computer's own reading of its sessions.",
      "Controls on those sessions (omni session continue|ask|answer|stop|restart) are sent to the computer that runs them, which checks its own rules and carries them out once. Automatic callers never act on another computer's sessions: each computer's own steward looks after its own.",
      'Automation switches: Settings › Other computers switches automatic actions off on another computer (it reads pending until that computer confirms, however long it is unreachable) or on a folder (every computer applies it to the sessions it runs). Overrides only ever switch things off; none relaxes a hard stop.',
      'Moving the same conversation to another computer (omni session relocate): a ready computer that offers it says "takes moved conversations" with the providers it can move; one that cannot says so, and a handoff (omni session handoff) is the way to give it work.',
      "A paired computer that publishes its conversation ledger (session parity) also shows the ledger as this Mac knows it: ready, as of <time> (a restored list, not confirmed live), older OmniConsole (paused and archived conversations not listed) or unreachable (last listed <time>). The lines come from this Mac's window; with no window (a headless relaunch) nothing is listed — read the kept copy of a paired computer's ledger with omni session ledger --host runtime:<name-or-id> instead, which needs no window.",
      '--json: {hosts: [{hostKey, kind (runtime|ssh), state, detail?, hostId?, capabilities, checkedAt, counts: {total, live, exited, unverifiable, working, needsYou, stalled} | null, ledger?: {hostId, generation, revision, source, state (ready|stale|older|unreachable), asOf}}], refreshing, switches: [{hostId, automation (on|off), at, state (applied|pending), setHere}], folderPolicies: {<folderId>: {automation?: "off"}}, thisHostOffElsewhere}.'
    ]
  }
]
