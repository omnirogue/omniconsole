import type { SessionAgentTemplate } from './session-agent-template'
import type { SessionParityFields, SessionParityPopulation } from './session-parity'
import type { SessionProjectThreadStatus } from './session-project-thread-status'
import type {
  SessionManageWorkflowAnchor,
  SessionWorkflowAnchorRef
} from './session-workflow-anchor'

/**
 * The contract behind `omni session list|continue|ask|stop|restart|rename|conflicts`: one
 * conversation managing the others on this computer, when the person asks it to.
 *
 * The acting conversation is named by its pane evidence (the same launch proof `omni outcome
 * commit` carries), never by a flag it could write itself; without that evidence it is the plain
 * local CLI. Every applied action is one line in `<userData>/session-actions.jsonl`.
 */

export const SESSION_MANAGE_RPC = {
  list: 'sessionManage.list',
  resume: 'sessionManage.resume',
  continueWhenIdle: 'sessionManage.continueWhenIdle',
  pending: 'sessionManage.pending',
  handoff: 'sessionManage.handoff',
  consolidate: 'sessionManage.consolidate',
  continue: 'sessionManage.continue',
  ask: 'sessionManage.ask',
  answer: 'sessionManage.answer',
  stop: 'sessionManage.stop',
  restart: 'sessionManage.restart',
  rename: 'sessionManage.rename',
  conflicts: 'sessionManage.conflicts',
  tidy: 'sessionManage.tidy',
  show: 'sessionManage.show',
  findOwner: 'sessionManage.findOwner',
  assign: 'sessionManage.assign'
} as const

/** Methods whose calls carry the acting pane's launch evidence (see the CLI envelope). */
export const SESSION_MANAGE_EVIDENCE_METHODS: ReadonlySet<string> = new Set([
  ...Object.values(SESSION_MANAGE_RPC),
  'sessionFolders.mutate',
  'sessionOrganization.organize'
])

/** The companion plan's words for where a conversation stands. */
export const SESSION_MANAGE_STATES = [
  'working',
  'queued',
  'provider-limited',
  'awaiting-user',
  'waiting-for-yes',
  'idle',
  'exited',
  'unknown'
] as const
export type SessionManageState = (typeof SESSION_MANAGE_STATES)[number]

/** docs/reference/ssh-execution-boundary.md: no synonyms, and loss of contact is never `exited`. */
export type SessionExecutionVerdict = 'live' | 'unverifiable' | 'exited'

/**
 * What the state was read from: a fresh hook report, the agent's last report (kept across a
 * restart), the terminal title, the rendered screen under the agent's own process, the process
 * table (an exit), the chat host, or nothing (`unknown`).
 */
export type SessionStateBasis =
  | 'hook'
  | 'last-report'
  | 'title'
  | 'screen'
  | 'process'
  | 'chat-host'
  /** The record of the workflow run its controller keeps (a workflow conversation has no pane). */
  | 'workflow'
  | 'none'

/**
 * No person is present (D3/D4/D5): the steward's rules loop, or an automatic cleanup session.
 * Main stamps it from its own records, never from anything a caller sends.
 */
export type SessionManageUnattended = {
  source: 'rules' | 'cleanup-run'
  /** The automation run of an automatic cleanup session. */
  runId?: string
  /** Epoch ms it was recorded. */
  since?: number
}

export const SESSION_STEWARD_TITLE = 'Session steward'

/**
 * Who acted: a conversation proven by its pane's launch evidence, the plain local CLI, or the
 * app's own steward. `steward` is built only by main-process code; no RPC schema can express it.
 */
export type SessionManageActor =
  | { kind: 'pane'; paneKey: string; title: string; unattended?: SessionManageUnattended }
  | {
      kind: 'cli'
      /** A pane the caller named but could not prove; recorded, never trusted. */
      unverifiedPaneKey?: string
      unattended?: SessionManageUnattended
    }
  | { kind: 'steward'; feature: SessionManageUnattended['source']; runId?: string }
  /** The person said Yes to a steward suggestion in Work (D5): person-approved, not unattended. */
  | { kind: 'steward'; feature: 'suggestion'; suggestionId: string }
  /**
   * Another computer, as this execution host derived it from the authenticated transport and the
   * origin's evidence (`sessionHostActor`); built only by main, never parsed from a request.
   */
  | {
      kind: 'remote'
      /** `sessionHostActorTitle`: who, on which computer (`Session steward on …` if unattended). */
      title: string
      computer: string
      peer: string
      requester: 'person' | 'pane' | 'cli'
      unattended?: SessionManageUnattended
    }

/** A steward line's path in the audit (`steward` on a session-actions line). */
export type SessionStewardAudit = {
  feature: SessionManageUnattended['source'] | 'suggestion'
  runId?: string
  suggestionId?: string
}

/** `accepted in Work`: the request every accepted suggestion's changes record. */
export const STEWARD_SUGGESTION_REQUEST = 'accepted in Work'

export type SessionManagePrompt = {
  kind: 'permission' | 'question'
  text: string
  options: { n: number; label: string }[]
  fingerprint: string
}

export type SessionPromptAnswer =
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'choose'; choice: number }
  | { kind: 'text'; text: string }

/** One conversation as the Conversations sidebar holds it and this host observes it. */
/**
 * One listed conversation. Session parity (step 8): its bucket, verification, tagged identity,
 * owner rest and stale flag, exactly as `omni session sidebar-counts` reports them (older hosts omit).
 */
export type SessionManageEntry = Partial<SessionParityFields> & {
  /** `--pane` for every other command; null only for a row with no pane yet (a pending launch). */
  paneKey: string | null
  tabId: string | null
  /** The live `omni terminal` handle; null when no live terminal backs it. */
  terminal: string | null
  title: string
  agent: string
  kind: 'terminal' | 'chat'
  worktreeId: string
  worktreePath: string | null
  workspace: string
  hostId: string | null
  /** "Clients / Acme" or "Saved Sessions / Q3"; null when unfiled. */
  folder: string | null
  saved: boolean
  archived: boolean
  pinned: boolean
  verdict: SessionExecutionVerdict
  state: SessionManageState
  stateBasis: SessionStateBasis
  /**
   * A terminal's agent provably holds it: its process is a recognized agent in the foreground (or
   * a program its agent vouched for with a live hook report). False at a shell or another program;
   * null when unreadable, and for chat sessions, which have no terminal. `continue`/`ask` need true.
   */
  agentForeground: boolean | null
  lastActivityAt: number | null
  /** Plain words: what it is waiting on, when anything. */
  waitingOn: string | null
  ask?: SessionManagePrompt
  /** The session's own open next steps, numbered for `session continue --choose <n>`. */
  pendingSteps: string[]
  queueLength: number
  keepGoing: boolean
  /** `--ref` for this conversation (`<agent>:<id>@<host>`), when its agent reported one. */
  ref?: string
  providerSessionId?: string | null
  transcriptPath?: string | null
  /** Why it is archived: `manual` (a person or agent) or `automatic` (a verified finish). */
  archiveKind?: 'manual' | 'automatic' | null
  /** The agent template it launched with (`omni agents`); null when the launch recorded none. */
  agentTemplate?: SessionAgentTemplate | null
  /** The steward tried and could not move it: when and why. Cleared by its next turn. */
  stalled?: { at: number; reason: string }
  /** Pane keys of sessions waiting on this one's result. */
  waitedOnBy?: string[]
  /** With `--project`: its status on the project page; null when it is none of them (idle). */
  projectStatus?: SessionProjectThreadStatus | null
  /** With `--project`: this is the project's chat, its coordinator. */
  projectCoordinator?: true
  /**
   * A runtime-owned terminal no window tab shows: running in the background, not in a window.
   * `session show` opens it visibly; `terminal close` ends it; nothing ends it automatically.
   * Absent from older hosts and from every sidebar row.
   */
  placement?: 'background-not-in-window'
  /**
   * A workflow conversation (no pane): its controller-owned run and the state observed for it —
   * the controller's own record when this host could read it. Absent from older hosts.
   */
  workflow?: SessionManageWorkflowAnchor
}

export type SessionManageListResult = {
  sessions: SessionManageEntry[]
  /** Older controllers omit this; inventory never proves full transcript/other-controller coverage. */
  scope?: {
    source: 'controller-sidebar'
    /**
     * `listed`: runtime-owned terminals no window tab shows are included (placement set);
     * `unavailable`: the window's publication could not tell. Absent from older hosts.
     */
    backgroundTerminals?: 'listed' | 'unavailable'
    includeArchived: boolean
    hostId?: string
    query?: string
    /** The project `--project` resolved to. */
    project?: { folderId: string; name: string; path: string }
  }
  /**
   * Session parity (C5): the UNFILTERED canonical population — every sidebar row whatever the
   * filters above — identical to `omni session sidebar-counts --json`'s. Older hosts omit it.
   */
  parity?: SessionParityPopulation
}

/** What `continue`, `ask`, `stop`, `restart` and `rename` answer, applied or as a dry run. */
export type SessionManageActionResult = {
  dryRun: boolean
  action: SessionManageAction
  target: { paneKey: string | null; title: string }
  actor: SessionManageActor
  /** One sentence naming what changed, or what would. */
  summary: string
  /** The exact text queued (or that would be), marker included. */
  sent?: string
  /** Keep going was on and was turned off first (or would be). */
  keepGoingStopped?: boolean
  /** The action ran but its audit line could not be written. */
  auditError?: string
}

export type SessionManageAnswerResult = SessionManageActionResult & {
  ask: SessionManagePrompt
  commandText: string[]
  chosen: { n?: number; label: string; value: string }
  delivery: 'dry-run' | 'recorded' | 'confirmed' | 'unconfirmed'
}

export type SessionManageAskResult = SessionManageActionResult & {
  /** Absent on a dry run. */
  outcome?: 'answered' | 'timeout' | 'failed'
  /** The target's reply to exactly this question (its hook's bounded copy, up to 32,000 chars). */
  reply?: string
  /** On timeout: whether the question was withdrawn unsent or had already been delivered. */
  question?: 'withdrawn' | 'delivered'
  failure?: string
  note?: string
}

export type SessionManageAction =
  | 'handoff'
  | 'consolidate'
  | 'session.create'
  | 'session.acknowledge'
  | 'continue'
  | 'assign'
  | 'ask'
  | 'answer'
  | 'stop'
  | 'restart'
  | 'resume'
  | 'rename'
  | 'session.move'
  | 'session.archive'
  | 'session.unarchive'
  | 'session.delete'
  | 'folder.move'
  | 'folder.reorder'
  | 'folder.delete'
  | 'folder.create'
  | 'folder.rename'
  | 'folder.color'
  | 'folder.project'

export type SessionConflictSession = { paneKey: string | null; title: string }

export type SessionConflictWorktree = {
  worktreeId: string
  path: string | null
  branch: string | null
  sessions: SessionConflictSession[]
}

export type SessionConflictsResult = {
  repos: {
    repo: string
    /** One file changed in two or more worktrees of the repo. */
    sharedFiles: { path: string; worktrees: SessionConflictWorktree[] }[]
    /** Two or more live sessions working in one worktree, and what it has changed. */
    sharedWorktrees: (SessionConflictWorktree & { files: string[] })[]
  }[]
  /** Live sessions with nothing git can compare, and why. */
  skipped: { worktreeId: string; path: string | null; reason: string; sessions: string[] }[]
  checkedWorktrees: number
}

/** `delete` only in `omni session tidy --delete`, which deletes instead of archiving. */
export type SessionTidyAction = 'archive' | 'hold' | 'skip' | 'delete'

/** Why a row is not archived, as a stable key an agent can count; absent from older hosts. */
export type SessionTidyGroup =
  | 'already-archived'
  | 'launch-pending'
  | 'other-omniconsole'
  | 'host-disconnected'
  | 'ssh-host'
  | 'unverifiable'
  | 'unknown-state'
  | 'pinned'
  | 'saved'
  | 'busy'
  | 'open-items'
  | 'held'
  /** `--delete` only: a routine runs in it. */
  | 'routine'
  /** A runtime-owned terminal no window tab shows; tidy keeps it and never ends it. */
  | 'background-not-in-window'
  /** A workflow never started, or whose Start is still being sent; always kept. */
  | 'workflow-draft'
  /** A workflow whose run is running or waits on the person; tidy never cancels a run. */
  | 'workflow-active'
  /** The controller that started it has no such run ("run not found"); kept unless --unverified. */
  | 'workflow-run-not-found'
  /** Its run's status could not be read ("status unavailable"); kept unless --unverified. */
  | 'workflow-status-unavailable'
  /** A review decision or a Question still waits on the person; only the person deletes it. */
  | 'awaiting-answer'

/** One conversation in `omni session tidy`'s plan: what it would do, and why, in plain words. */
export type SessionTidyRow = {
  paneKey: string | null
  tabId: string | null
  title: string
  folder: string | null
  hostId: string | null
  state: SessionManageState
  verdict: SessionExecutionVerdict
  action: SessionTidyAction
  reason: string
  group?: SessionTidyGroup
  /** Held, but archived because the person's request named it (`--include`). */
  included?: boolean
  /** `--delete --unverified`: this computer runs it but cannot verify it; its row goes here, no terminal ends. */
  unverified?: boolean
  /** Set by `--apply` on archive (or delete) rows: what happened when it was re-checked. */
  outcome?: 'archived' | 'deleted' | 'skipped' | 'failed'
  outcomeReason?: string
  auditError?: string
  /** A pane-less workflow anchor: the controller and run it is re-checked and addressed by. */
  workflow?: SessionWorkflowAnchorRef
}

export type SessionTidyResult = {
  dryRun: boolean
  actor: SessionManageActor
  rows: SessionTidyRow[]
  /** Titles that name a launcher or an id instead of the work; informational, never renamed. */
  titleFlags: { paneKey: string | null; tabId: string | null; title: string }[]
  counts: { archive: number; hold: number; skip: number; junkTitles: number; delete?: number }
  /** `--apply` only. */
  applied?: { archived: number; skipped: number; failed: number; deleted?: number }
  /** `delete` when the person asked tidy to delete instead of archive; absent from older hosts. */
  mode?: 'archive' | 'delete'
  /** Added by the CLI from `rows`, so it reads the same against an older host. */
  report?: SessionTidyReport
}

type SessionTidyRef = { paneKey: string | null; tabId: string | null; title: string }

/** What a tidy run did, grouped: an agent reports this, never a bare success. */
export type SessionTidyReport = {
  archived: SessionTidyRef[]
  /** `--delete` runs. */
  deleted?: SessionTidyRef[]
  /** Planned for archive, then found changed (or gone) at the re-check just before it. */
  changed: (SessionTidyRef & { reason: string })[]
  failed: (SessionTidyRef & { reason: string })[]
  /** Not archived, one entry per reason, largest first. */
  notArchived: { group: SessionTidyGroup | 'other'; reason: string; count: number }[]
}

/** A marker in front of every prompt another session sends; the agent reads who sent it. */
export function sessionManagePromptMarker(actorTitle: string): string {
  return `[from ${actorTitle}] `
}

/** The id near its start ties the answering turn to this one question, never another's. */
export function sessionManageQuestionMarker(actorTitle: string, requestId: string): string {
  return `[Question ${requestId} from ${actorTitle} — answer only, change nothing] `
}

const SESSION_MANAGE_MARKED_PROMPT = /^\[(?:from [^\]\n]+|Question q-[0-9a-f]{8} from [^\]\n]+)\]/

/** A prompt another session or the steward sent (its marker leads), never the person's own words. */
export function isSessionManageMarkedPrompt(text: string | null | undefined): boolean {
  return SESSION_MANAGE_MARKED_PROMPT.test(text?.trimStart() ?? '')
}

/** A short, unique request id for one question (`q-` and 8 hex digits). */
export function sessionManageQuestionId(uuid: string): string {
  return `q-${uuid
    .replace(/[^0-9a-f]/gi, '')
    .toLowerCase()
    .padEnd(8, '0')
    .slice(0, 8)}`
}

const ACTOR_TITLE_MAX = 80

/**
 * One line, no brackets, bounded: a title cannot close the marker early or span lines. Anything
 * unattended reads as the steward, so its marker is `[from Session steward] `.
 */
export function sessionManageActorTitle(actor: SessionManageActor): string {
  if (actor.kind === 'remote') {
    return actor.title
  }
  if (actor.kind === 'steward' || actor.unattended) {
    return SESSION_STEWARD_TITLE
  }
  if (actor.kind === 'cli') {
    return 'omni CLI'
  }
  const cleaned = actor.title
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ACTOR_TITLE_MAX)
  return cleaned || 'another session'
}
