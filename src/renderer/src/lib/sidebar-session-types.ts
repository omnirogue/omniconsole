import type { AppState } from '@/store'
import type { SessionArchiveProjection } from '../../../shared/session-archive-projection'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type { SidebarSessionLabelSource } from './sidebar-session-label'
import type { SidebarSessionContext } from './sidebar-session-context'
import type { SidebarWorkflow } from './local-workflow-tab-status'
import type { MirroredSidebarWorkflow } from './mirrored-workflow-rows'
import type {
  MirroredConversationRowSource,
  MirroredSidebarConversation
} from './mirrored-conversation-row-types'

export type SidebarSession = {
  launchPending?: boolean
  rowKey: string
  sessionKey: string | null
  worktreeId: string
  hostId: ExecutionHostId | null
  /** Computer shown in the sidebar; hostId remains the conversation control owner. */
  displayHostId?: ExecutionHostId
  tabId: string | null
  paneKey: string | null
  kind: 'terminal' | 'structured'
  structuredSessionId?: string
  label: string
  /** Where `label` came from; set by this builder (absent on rows other builders add). */
  labelSource?: SidebarSessionLabelSource
  /** The title the person or a launcher set, when there is one; the app never replaces it. */
  customTitle?: string
  workspaceLabel: string
  agent: string
  providerSession?: AgentProviderSessionMetadata
  unavailable: boolean
  /** Authoritative placement from the computer running a mirrored pane, when supported. */
  ownerArchive?: SessionArchiveProjection
  /**
   * Set once for a terminal pane whose folder identity has moved from a
   * provisional pane key onto a freshly-known provider session key. A
   * consumer (see session-folder-key-migration.ts) folds any folder
   * membership from `from` onto `to` and drops `from`, so the conversation
   * never falls out of its folder and a later, unrelated session on the same
   * pane never inherits it.
   */
  folderKeyMigration: { from: string; to: string } | null
  /** Set for Council, Discover and Build + Review conversations: preset and real run state. */
  workflow?: SidebarWorkflow
  /** A paired controller's workflow conversation (step 9): counted under it, opened there. */
  mirroredWorkflow?: MirroredSidebarWorkflow
  /**
   * The paired owner's conversation-ledger record that vouches for this row (session parity,
   * step 6): its rest, its tri-state archive and folder, and whether the owner lists it.
   */
  mirroredConversation?: MirroredSidebarConversation
}

export type SidebarSessionSource = SidebarSessionContext &
  Pick<
    AppState,
    | 'tabsByWorktree'
    | 'unifiedTabsByWorktree'
    | 'terminalLayoutsByTabId'
    | 'agentStatusByPaneKey'
    | 'sleepingAgentSessionsByPaneKey'
    | 'pendingStartupByTabId'
    | 'automaticAgentResumeClaimsByTabId'
  > &
  // Optional so partial store doubles keep working; absent means "no status pushed yet".
  Partial<Pick<AppState, 'localWorkflowStatusByTabId' | 'buildReview'>> &
  Partial<Pick<AppState, 'localWorkflowHydrationByTabId'>> &
  Partial<Pick<AppState, 'mirroredWorkflowRecordsByOwner'>> &
  MirroredConversationRowSource
