import type { SessionAgentTemplate } from './session-agent-template'
import type { SessionConversationTitleSource } from './session-conversation-ledger-contract'
import type { SessionDoneArchivePolicy } from './session-done-archive'
import type { SessionParityFields } from './session-parity'
import type { SessionProjectThreadStatus } from './session-project-thread-status'
import type { UnreachableBlankClock } from './session-steward-unreachable-blank'
import type { SessionManageWorkflowAnchor } from './session-workflow-anchor'
/**
 * What `sessionManage.*` asks the desktop window, over the same relay `omni folder` uses: the
 * Conversations sidebar lives in the window's store, so its rows, a rename, a resume and the toast
 * for each change are the window's to answer.
 */

import type { ConversationSource } from './conversation-source'
import type { SessionShowMode } from './session-show'
import type {
  OrganizationRelayedChange,
  OrganizationRelayedOutcome
} from './session-organization-change'

/** Why a row's owning computer cannot be verified (session inventory ownership quarantine), or
 *  its owner omitted it without evidence it closed (`absence-unverified`, scoped absence). */
export type SessionOwnershipUnverifiedReason =
  | 'conflicting-provenance'
  | 'unresolved-workspace'
  | 'absence-unverified'

/**
 * One conversation row as the sidebar lists it, with its folder, archive and pin placement.
 * Session parity (step 8) adds its bucket, verification, tagged identity, owner rest and stale flag
 * (session-parity.ts), which `omni session list` reports as `sidebar-counts` does; older windows
 * omit them.
 */
export type SessionManageSidebarRow = Partial<SessionParityFields> & {
  /** Session parity (step 8): `bucket === 'ownerListed'`; older windows omit it. */
  ownerListed?: boolean
  rowKey: string
  /** The folder-membership and archive key (`sessionKey ?? rowKey`). */
  viewKey: string
  /** A terminal pane's key, or the pane key a chat session is addressed by. */
  paneKey: string | null
  tabId: string | null
  kind: 'terminal' | 'structured'
  structuredSessionId: string | null
  worktreeId: string
  hostId: string | null
  /** Canonical pane/tab on a paired owner; viewer mirror ids are never control addresses. */
  ownerTarget?: { paneKey: string | null; tabId: string | null }
  /** Its SSH host or paired runtime is not connected. */
  hostUnavailable: boolean
  /** Its owning computer cannot be verified; listed as unverifiable, never hidden. */
  ownershipUnverified?: SessionOwnershipUnverifiedReason | null
  /**
   * Only this computer's saved record of another computer's pane: no tab here, no host this
   * computer can name and no workspace any computer lists. Deleting it (`--unverified` only)
   * drops that record and touches nothing anywhere else; older windows omit it.
   */
  strandedMirrorRecord?: true
  /**
   * Only this computer's saved record of another computer's pane, whatever its host: no tab of it
   * here. `omni session delete --unverified` drops that record locally instead of sending the
   * person to the owner, which lists no such row; older windows omit it.
   */
  recordOnlyMirror?: true
  /**
   * The paired computer (environment id) that runs this conversation and lists it in its
   * conversation ledger (session parity, step 7): its execution owner. Delete refuses it here,
   * `--unverified` included; it is deleted on that computer. Older windows omit it.
   */
  mirroredConversationOwner?: string
  title: string
  /**
   * Where `title` came from (the sidebar label's source): `agent` means it is no title to share —
   * possibly the record's prompt — so a published copy names the agent instead. Older windows omit it.
   */
  titleSource?: SessionConversationTitleSource
  agent: string
  workspace: string
  worktreePath: string | null
  repoId: string | null
  repoLabel: string | null
  branch: string | null
  /** `folder` has no git; `unknown` when the window does not know the workspace. */
  workspaceKind: 'git' | 'folder' | 'unknown'
  folderId: string | null
  folder: string | null
  saved: boolean
  /** Under Archived in the sidebar, by hand or aged there. */
  archived: boolean
  archivedByHand: boolean
  pinned: boolean
  /** Its tab is still launching the agent. */
  launchPending: boolean
  /** The window holds a checkpoint that resumes this provider conversation. */
  resumable: boolean
  /** Its pane's foreground is proven back at the shell (OSC 133;D): process-grade exit evidence. */
  shellForeground: boolean
  /** Another pane of a conversation the sidebar already lists once; addressable, not listed. */
  folded: boolean
  /** A routine owns it, so no other task is routed in; older windows omit it. */
  routine?: boolean
  /** The provider conversation its agent reported; older windows omit it (join unknown). */
  providerSessionId?: string | null
  transcriptPath?: string | null
  /** Why it is archived: by a person or an agent (`manual`), or filed after a verified finish. */
  archiveKind?: 'manual' | 'automatic' | null
  /** The agent template recorded at launch; null when the launch recorded none. */
  agentTemplate?: SessionAgentTemplate | null
  /** The tab's launch record even after its agent exited; only carried onto a resumed tab. */
  resumeAgentTemplate?: SessionAgentTemplate | null
  /** Hidden from the sidebar by hand; absent from an older window. */
  hidden?: boolean
  /** Snoozed until this ISO time; absent from an older window. */
  waitingUntil?: string | null
  /** The person brought it back from the archive, so nothing archives it by itself again. */
  autoArchiveKeep?: boolean
  /** Current Done/attention revision; null means blocked, absent means an older window. */
  doneArchiveRevision?: string | null
  /** Persisted continuous Done clock, valid only for this exact revision and account. */
  doneArchivePolicy?: SessionDoneArchivePolicy | null
  /**
   * Current idle-and-unprompted revision for the empty-session rule: it changes on any status
   * update, and null means the window sees a prompt, work, attention or a hold. Absent from an
   * older window, which never archives an empty session.
   */
  emptyArchiveRevision?: string | null
  /** When its tab was last on screen in this window run; absent when never, or an older window. */
  lastSeenAt?: number | null
  /**
   * A blank session on an unavailable SSH host: its revision (null otherwise) and the window's
   * persisted clock of how long that has held. Absent from an older window, which never files one.
   */
  unreachableBlankRevision?: string | null
  unreachableBlankPolicy?: UnreachableBlankClock | null
  /**
   * Set only when the request named a project, and only on that project's threads: its status
   * there and whether it is the project's chat (its coordinator).
   */
  projectThread?: { status: SessionProjectThreadStatus | null; coordinator: boolean }
  /**
   * A workflow conversation (a tab with no pane): the run its controller owns and what the window
   * last read of it. Absent from an older window, whose pane-less rows keep today's handling.
   */
  workflow?: SessionManageWorkflowAnchor
}

/** Explicit acknowledgement prevents older windows from returning an apparently empty project. */
export type SessionManageProjectRowsReply = {
  projectFolderId: string
  rows: SessionManageSidebarRow[]
}

/** A queued prompt the toast's Undo takes back out, while it is still waiting. */
export type SessionManageNoticeUndo = {
  kind: 'dequeue'
  source: ConversationSource
  entryId: string
}

export type SessionManageArchiveTarget = Pick<
  SessionManageSidebarRow,
  'viewKey' | 'worktreeId' | 'tabId' | 'kind' | 'structuredSessionId' | 'hostId'
> & { paneKey: string }

export type SessionManageRendererRequest =
  /**
   * With `projectFolderId`, the project's threads carry `projectThread`; `requireReady` refuses a
   * window that has not restored its sessions yet.
   */
  | { kind: 'listSessions'; projectFolderId?: string; requireReady?: true }
  | {
      kind: 'fileTransferredSession'
      operationId: string
      target: SessionManageArchiveTarget
      folderId: string | null
      expiresAt: number
    }
  | { kind: 'readTransferFileReceipt'; operationId: string }
  | {
      kind: 'archiveSessions'
      operationId: string
      commitToken: string
      acknowledgedTarget: SessionManageArchiveTarget
      targets: SessionManageArchiveTarget[]
      reason: string
      expiresAt: number
    }
  | { kind: 'readTransferArchiveReceipt'; operationId: string }
  | {
      kind: 'renameSession'
      paneKey?: string
      tabId?: string
      title: string
      /** The recorded change main prepared (opId, who, origin, why); an older window ignores it. */
      change?: OrganizationRelayedChange
    }
  | {
      kind: 'resumeSession'
      paneKey?: string
      tabId?: string
      launchTabId?: string
      /** Only a pane hibernation slept that still has no PTY (a review wake after a restart). */
      onlySleptPane?: true
    }
  | { kind: 'conversationOrganization'; hostId: string; sessionId: string }
  /** Is this pane one hibernation slept whose PTY the daemon says is gone (review Reject)? */
  | { kind: 'paneParkedBySleep'; paneKey: string }
  /** The session moved to another computer: drop its parked checkpoint (false when it runs). */
  | { kind: 'forgetSleptPane'; paneKey: string }
  | { kind: 'notice'; summary: string; undo?: SessionManageNoticeUndo }
  | {
      kind: 'showSession'
      paneKey?: string
      tabId?: string
      mode: SessionShowMode
      flash: boolean
    }
  /** A finished one-off cleanup session: close it once its host confirms (an older window ignores it). */
  | { kind: 'scheduleFinish'; paneKey?: string; tabId?: string; action: 'end' }
  /** Read-only: the sidebar's counts as last rendered (session-count step 0; an older window ignores it). */
  | { kind: 'readSidebarCounts' }
  /** Read-only (session parity, step 8): the unfiltered parity population; null while restoring. */
  | { kind: 'readParityPopulation' }
  /** Read-only (session parity, step 8, G2): each paired owner's ledger state as this window knows it. */
  | { kind: 'readOwnerLedgers' }
  /** An OmniOS answer typed through the pane card's own send; an older window rejects the kind. */
  | {
      kind: 'answerOmniosQuestion'
      paneKey: string
      interactivePrompt: string
      answers: Record<string, string>
      skipped: boolean
      /** Main knows the question only from an old or restored report: type only if it is on screen. */
      confirmOnScreen?: boolean
    }

export type SessionManageOmniosAnswerReply =
  | { delivered: true }
  | { delivered: false; error: string }

export type SessionManageRenameReply = {
  summary: string
  before: string
  after: string
  /** A window that applied `change` answers with what it changed. */
  organization?: OrganizationRelayedOutcome
}
export type SessionManageResumeReply = { summary: string; tabId: string | null }

/**
 * How this window has a conversation filed, read from its view keys even when no row lists it
 * (a closed tab). Deleted and hidden are the person's; resuming must not bring them back.
 */
export type SessionManageConversationOrganization = {
  deleted: boolean
  hidden: boolean
  archiveKind: 'manual' | 'automatic' | null
  /** The view keys that delete or hide it (newer windows), so an answered decision can undo exactly those. */
  deletedKeys?: string[]
  hiddenKeys?: string[]
}
