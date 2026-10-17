import type { SessionArchiveProjection } from './session-archive-projection'
import type { SessionAgentTemplate } from './session-agent-template'
import type { AiVaultSessionTitle } from './ai-vault-session-title'
import type { TuiAgent } from './tui-agent'
import type { BuildReviewDraft } from './build-review-draft'
import type { EvolveDraft } from './evolve-workflow-draft'
import type { LocalWorkflowDraft } from './local-workflow-draft'
import type { LocalWorkflowLaunch } from './local-workflow-launch'
import type { OrganizationTitleOrigin } from './session-organization-change'

// ─── Terminal Tab (legacy — used by persistence and TerminalContentSlice) ─
export type TerminalTab = {
  id: string
  /** Renderer-only reservation; excluded from session persistence and never mounts a PTY. */
  conversationLaunchPending?: boolean
  /** Durable workflow anchor; it never owns a parent PTY. */
  localWorkflow?: {
    preset: 'council' | 'discover' | 'build-review' | 'evolve'
    prompt: string
    launch?: LocalWorkflowLaunch
    buildReviewDraft?: BuildReviewDraft
    buildReviewPipelineId?: string
    evolveDraft?: EvolveDraft
    draft?: LocalWorkflowDraft
    /** Council/Discover execution id, or an Evolve run's `evo_` id. */
    executionId?: string
    startRequest?: { requestId: string; draft: LocalWorkflowDraft }
  }
  ptyId: string | null
  worktreeId: string
  title: string
  /** Stable fallback label for default-named terminals ("Terminal 1", etc.).
   *  Why: agent CLIs overwrite the live title via OSC updates, but OmniConsole still
   *  needs the original terminal label for numbering and reset behavior. */
  defaultTitle?: string
  /** Stable opt-in label derived from the first known agent prompt. */
  generatedTitle?: string | null
  /** Stable AI Vault conversation name, bound to its provider session identity. */
  aiVaultTitle?: AiVaultSessionTitle | null
  /** Stable label from the tab-bar Quick Command that created this terminal. */
  quickCommandLabel?: string | null
  customTitle: string | null
  /** Who chose `customTitle`'s words; absent reads as unknown. */
  customTitleOrigin?: OrganizationTitleOrigin
  color: string | null
  /** Pinned tabs survive "close others"; host-persisted for remote servers. */
  isPinned?: boolean
  /** Per-tab view preference (terminal xterm vs native chat); host-persisted so
   *  paired clients converge. Optional: older persisted tabs default to 'terminal'. */
  viewMode?: 'terminal' | 'chat'
  sortOrder: number
  createdAt: number
  /** Bumped on shutdown so TerminalPane remounts with a fresh PTY. */
  generation?: number
  /** Why: records the shell this tab was opened with (e.g. 'wsl.exe') so the
   *  PTY and tab icon stay stable even if the default shell setting changes
   *  later. Older persisted tabs may omit this field. */
  shellOverride?: string
  /** Keeps an ephemeral host fallback out of the active project's runtime. */
  forceHostRuntime?: boolean
  /** Why: explorer-created terminals can start below the workspace root while
   *  still belonging to that workspace for tab/session ownership. */
  startupCwd?: string
  /** Why: the coding-harness agent OmniConsole launched in this tab. Lets the tab bar
   *  show the provider icon immediately, before the agent emits its first hook
   *  event (a freshly-launched, idle agent reports no live status yet). Live
   *  hook status overrides this once the agent does anything. Plain terminals
   *  and manually-started agents omit it. */
  launchAgent?: TuiAgent
  /** The agent template this session started with; absent reads as Default. */
  agentTemplate?: SessionAgentTemplate
  /** Why: when `setActiveWorktree` bumps generation on all-dead tabs to drive a
   *  TerminalPane remount, the fresh PTY that results is caused by navigation,
   *  not by the user doing work. Without this flag the resulting
   *  `updateTabPtyId` call would call `bumpWorktreeActivity` and flip the
   *  sidebar's recency sort on every click — the reorder-on-click bug. The
   *  flag is set by `setActiveWorktree` and consumed by the activation-driven
   *  PTY lifecycle calls that follow, which then suppress activity bumps and
   *  `sortEpoch` increments. Split layouts use a numeric count because one tab
   *  can remount several panes. Never persisted — it is a transient handoff. */
  pendingActivationSpawn?: boolean | number
  /** Receiver-only, never persisted: a paired owner omitted this mirrored row without evidence it
   *  closed (session-count fix step 6). Kept, labelled "can't verify" and never woken until a frame
   *  lists it again or proves it gone. */
  mirrorAbsenceUnverified?: true
  /** Receiver-only control address from the paired owner's accepted inventory. */
  runtimeOwnerTabId?: string
  /** Receiver-only owner placement, keyed by canonical leaf id; never a local organization edit. */
  runtimeOwnerArchiveByLeafId?: Record<string, SessionArchiveProjection>
  /** Receiver-only owner sidebar name, keyed by canonical leaf id; never a local rename. Persisted
   *  so a restored mirror keeps the owner's names until its next frame. */
  runtimeOwnerTitleByLeafId?: Record<string, string>
}

export type TerminalPaneSplitDirection = 'vertical' | 'horizontal'

export type TerminalPaneLayoutNode =
  | {
      type: 'leaf'
      leafId: string
    }
  | {
      type: 'split'
      direction: TerminalPaneSplitDirection
      first: TerminalPaneLayoutNode
      second: TerminalPaneLayoutNode
      /** Flex ratio of the first child (0–1). Defaults to 0.5 if absent. */
      ratio?: number
    }

export type TerminalLayoutSnapshot = {
  root: TerminalPaneLayoutNode | null
  activeLeafId: string | null
  expandedLeafId: string | null
  /** Live PTY IDs per leaf for in-session remounts such as tab-group moves.
   *  Not used for app restart because PTYs are transient processes. */
  ptyIdsByLeafId?: Record<string, string>
  /** Serialized terminal buffers per leaf for scrollback restoration on restart. */
  buffersByLeafId?: Record<string, string>
  /** Durable scrollback snapshot refs per leaf; raw bytes live outside session JSON. */
  scrollbackRefsByLeafId?: Record<string, string>
  /** User-assigned pane titles, keyed by stable layout leaf UUID.
   *  Persisted alongside buffers via the existing session:set flow. */
  titlesByLeafId?: Record<string, string>
}
