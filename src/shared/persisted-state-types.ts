import type { FolderWorkspaceAttachedReposById } from './folder-workspace-attached-repos'
import type { WorkflowModelPreset } from './workflow-model-presets'
import type { WorkflowModelTiers } from './workflow-model-tiers'
import type { WorkPlanLayout } from './work-plan-layouts'
import type { ExecutionHostId } from './execution-host'
import type { SessionChain } from './session-chain-types'
import type { LocalRunDraft } from './local-run-graph'
import type {
  RemovedSshTargetTombstone,
  SshPtyConsumerRecovery,
  SshRemotePtyLease,
  SshTarget
} from './ssh-types'
import type { Automation, AutomationRun } from './automations-types'
import type { ConsoleAutoAdvancePreference } from './console-auto-advance'
import type { MigrationUnsupportedPtyEntry } from './agent-status-types'
import type { FeatureInteractionTelemetryBucketState } from './feature-interactions'
import type { CodexResetCreditAttemptLedger } from './codex-reset-credit-attempt-ledger'
import type { DiffComment } from './diff-comment-types'
import type { FolderWorkspace, WorkspaceKey } from './folder-workspace-types'
import type { GlobalSettings } from './global-settings-types'
import type { IssueInfo, PRInfo } from './github/pull-request-types'
import type { OnboardingState } from './onboarding-state-types'
import type { PromptQueues } from './prompt-queue-types'
import type { UpNextDrafts } from './up-next-draft-schema'
import type { PersistedUIState } from './persisted-ui-state-types'
import type { ProjectGroup } from './project-group-types'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import type { SparsePreset } from './worktree/create-types'
import type { RetiredNameRegistry } from './worktree/retired-name-registry'
import type { WorkspaceLineage, WorktreeLineage } from './worktree/lineage-types'
import type { WorktreeMeta } from './worktree/meta-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'

export type LegacyPaneKeyAliasEntry = {
  ptyId: string
  /** Physical pane key retained by the live process; name is persisted for compatibility (UUID keys after detach). */
  legacyPaneKey: string
  /** Current logical owner pane key. May belong to another tab after detach. */
  stablePaneKey: string
  updatedAt: number
}

/** Last tab selection a paired client made in a worktree; restores phone navigation across host restarts. */
export type PersistedMobileClientTabSelection = {
  activeTabId: string | null
  activeGroupId: string | null
  activeTabIdByGroupId: Readonly<Record<string, string>>
}

/** deviceId → worktreeId → selection. */
export type PersistedMobileClientTabSelections = Record<
  string,
  Record<string, PersistedMobileClientTabSelection>
>

// ─── Persistence shape ──────────────────────────────────────────────
export type PersistedState = {
  schemaVersion: number
  repos: Repo[]
  projects: Project[]
  projectHostSetups: ProjectHostSetup[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  /** Folder-workspace review notes, keyed by FolderWorkspace.id. Top-level, NOT nested in
   *  folderWorkspaces[]: normalizeFolderWorkspaces rebuilds each record field-by-field, so an
   *  older build drops nested fields, while unknown top-level keys round-trip untouched.
   *
   *  WRITE-ONLY PROJECTION. FolderWorkspace.diffComments is the single in-memory home; load()
   *  hydrates from this key and then deletes it from Store state, and buildStateToSave() is the
   *  only producer of it. Never read Store.state.folderWorkspaceDiffComments outside load(). */
  folderWorkspaceDiffComments?: Record<string, DiffComment[]>
  /** Repos each folder workspace works on, keyed by FolderWorkspace.id. Top-level for the same
   *  reason as folderWorkspaceDiffComments: older builds keep unknown top-level keys intact. */
  folderWorkspaceAttachedRepos?: FolderWorkspaceAttachedReposById
  /** Sparse-checkout presets keyed by repoId. */
  sparsePresetsByRepo: Record<string, SparsePreset[]>
  /** Generated workspace names already issued, keyed by repoId. Suppresses reissuing a name so a
   *  recreated workspace never lands on a prior occupant's path and inherits agent state keyed to
   *  that cwd. Grows monotonically within a repo — entries are never removed on workspace deletion
   *  — and the repo-keyed copy is dropped when the repo is removed. Readers union across repos
   *  that create into the same cwd namespace; remote namespaces also retain a compact tombstone.
   *
   *  Stored compacted, not as a flat list: a fully spent tier collapses into the row's watermark. */
  retiredWorktreeNamesByRepo?: Record<string, RetiredNameRegistry>
  /** Compacted remote cwd tombstones outlive repo ids, so remove/re-add cannot reissue a path. */
  retiredWorktreeNamesByNamespace?: Record<string, RetiredNameRegistry>
  /** Per paired device last tab selection by worktree; keeps mobile navigation across host restarts. */
  mobileClientTabSelectionsByDeviceId?: PersistedMobileClientTabSelections
  worktreeMeta: Record<string, WorktreeMeta>
  /** Canonical host/instance metadata; optional for legacy profiles. */
  worktreeMetaByIdentity?: Record<string, WorktreeMeta>
  /** Host-qualified locator aliases to canonical identity keys. */
  worktreeIdentityAliases?: Record<string, string[]>
  worktreeLineageById: Record<string, WorktreeLineage>
  workspaceLineageByChildKey: Record<WorkspaceKey, WorkspaceLineage>
  settings: GlobalSettings
  ui: PersistedUIState
  githubCache: {
    pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
    issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
  }
  /** Legacy single-blob session, kept as the canonical 'local' host partition so an app downgrade still reads its workspace. */
  workspaceSession: WorkspaceSessionState
  /** Per-execution-host session partitions for non-'local' hosts (ssh:/runtime:); 'local' stays in workspaceSession so pre-partition builds keep working. */
  workspaceSessionsByHostId?: Partial<Record<ExecutionHostId, WorkspaceSessionState>>
  sshTargets: SshTarget[]
  /** Highest SSH target registration generation issued; prevents identity reuse after rollback. */
  sshTargetGenerationCounter?: number
  /** SSH config aliases the user deleted; suppresses re-import from ~/.ssh/config so a deleted host doesn't reappear. */
  deletedSshConfigAliases: string[]
  /** Identity records for removed SSH targets so a re-added host can re-adopt workspaces orphaned on the old target id. */
  removedSshTargetTombstones?: RemovedSshTargetTombstone[]
  sshRemotePtyLeases: SshRemotePtyLease[]
  /** Main-owned authenticated relay recovery records; never expose through renderer settings APIs. */
  sshPtyConsumerRecoveries?: SshPtyConsumerRecovery[]
  /** Live local Claude daemon session ids; seeds the live-PTY gate so early OAuth refresh can't rotate the single-use refresh token out from under a running daemon. */
  claudeLivePtySessionIds?: string[]
  migrationUnsupportedPtyEntries: MigrationUnsupportedPtyEntry[]
  legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[]
  automations: Automation[]
  automationRuns: AutomationRun[]
  /** Per-workflow console auto-advance preference, keyed by workflow id. Off unless the person
   *  turned it on; the key is absent on profiles that never used it. */
  consoleWorkflowAutoAdvance?: Record<string, ConsoleAutoAdvancePreference>
  /** Personal session chains (ordered successors queued after a live session), beside automations. */
  sessionChains?: SessionChain[]
  /** Prompts queued for a conversation, keyed by its source row key. Ordinary messages:
   *  no outcome, no chain, no plan — the person's own next prompt, held until the agent
   *  finishes. Entries keep their delivery receipt so a restart never re-sends one. */
  workflowModelPresets?: WorkflowModelPreset[]
  /** The person's own Cheap / Standard / Frontier lineups; absent while they use the built-in ones. */
  workflowModelTiers?: WorkflowModelTiers
  workPlanLayouts?: WorkPlanLayout[]
  promptQueues?: PromptQueues
  /** Up next blocks composed but not queued yet, keyed by conversation row key. Intentions,
   *  never work: nothing here is in a plan and the outcome tick never reads it — it exists so
   *  the composer shows the same unqueued blocks after a restart. */
  upNextDrafts?: UpNextDrafts
  /** Saved local-run graph definitions, kept beside automations for the canvas. */
  localRunDrafts?: LocalRunDraft[]
  onboarding: OnboardingState
  /** Main-owned telemetry de-dupe marker; never exposed through PersistedUIState. */
  featureInteractionTelemetryBuckets?: FeatureInteractionTelemetryBucketState
  /** Main-owned reset mutation journal. Never expose this through renderer settings APIs. */
  codexResetCreditAttemptLedger?: CodexResetCreditAttemptLedger
}
