import { LAUNCH_PROVENANCE_CAPABILITY } from './launch-cause'
import { REMOTE_SERVER_UPDATE_CAPABILITY } from './remote-server-update'
import {
  OMNI_CONSOLE_MCP_DEFAULT_RUNTIME_CAPABILITY,
  OMNI_CONSOLE_MCP_LEGACY_RUNTIME_CAPABILITY
} from './omni-console-mcp-launch-defaults'
export { OMNI_CONSOLE_MCP_DEFAULT_RUNTIME_CAPABILITY } from './omni-console-mcp-launch-defaults'
import {
  SKILL_BUNDLE_INSTALL_CAPABILITY,
  SKILL_DELETE_CAPABILITY,
  SKILL_INSTALL_CAPABILITY,
  SKILL_INSTALL_CANCEL_CAPABILITY,
  SKILL_INSTALL_PROGRESS_CAPABILITY,
  SKILL_INSTALL_PROVIDERS_CAPABILITY,
  SKILL_INSTALL_RESULT_V2_CAPABILITY,
  SKILL_MANAGEMENT_CAPABILITY,
  SKILL_UPLOAD_CAPABILITY
} from './skill-install-capability'
export { SKILL_INSTALL_RESULT_V2_CAPABILITY } from './skill-install-capability'
import { SESSION_HOST_CLIENT_CAPABILITIES } from './session-host-capability-names'
import { SESSION_QUESTION_OWNER_ANSWER_CAPABILITY } from './session-question-owner-answer'

// Why: declares the OmniConsole runtime RPC compatibility contract. Desktop,
// headless server, CLI, and mobile builds may drift in app version, but
// they must agree on this protocol range before runtime RPCs are allowed.
//
// Bump RUNTIME_PROTOCOL_VERSION when:
//   - You remove an RPC method or required parameter that clients use.
//   - You change the meaning (units, nullability) of an existing field
//     clients read.
//   - You change encrypted framing, terminal stream framing, or auth.
// Do NOT bump for:
//   - Adding new RPC methods.
//   - Adding new optional fields on existing methods.
//   - Adding new ignorable event types.
//
// Bump MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION when a runtime server must
// refuse older clients. Bump MIN_COMPATIBLE_RUNTIME_SERVER_VERSION when
// this client build requires a newer server. Exact app-version equality is
// never required; these numbers define the supported compatibility window.

// Why 3, not 4: hub-task binding and the omni-console MCP default are negotiated as capabilities;
// bumping the wire version would only cut old clients off from new hosts (cross-version wire test).
export const RUNTIME_PROTOCOL_VERSION = 3
export const MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION = 2
export const MIN_COMPATIBLE_RUNTIME_SERVER_VERSION = 2

export const PROJECT_HOST_SETUP_RUNTIME_CAPABILITY = 'project-host-setup.v1' as const
/** `sessionProjects.list` answers paired desktops (upgrade plan PR 6). */
export const SESSION_PROJECTS_LIST_RUNTIME_CAPABILITY = 'session-projects.list.v1' as const
/** Routines keep `sessionFolder`: runs join that project (upgrade plan PR 12). */
export const SESSION_FOLDER_AUTOMATIONS_RUNTIME_CAPABILITY =
  'automations.session-folder.v1' as const
export const TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY = 'task-source-context.v1' as const
export const WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY = 'workspace-run-context.v1' as const
export const WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY =
  'worktree.linked-work-item-context.v1' as const
export const WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY =
  'worktree.github-pr-suppression.v1' as const
export const REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY = 'remote-runtime.shared-control.v1' as const
export const ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY = 'orchestration.federation.v1' as const
export const ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY =
  'orchestration.federation-control-mail.v1' as const
export const ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY =
  'orchestration.federation-lifecycle-settlement.v1' as const
export const ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY =
  'orchestration.worker-stop-verdict.v1' as const
export const OMP_OPENROUTER_ROUTING_RUNTIME_CAPABILITY = 'omp-openrouter-routing-v1' as const
export const ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY =
  'orchestration.worker-launch-preferences.v1' as const
export const AGENT_SESSION_EFFORT_ONLY_LAUNCH_RUNTIME_CAPABILITY =
  'agent-session.effort-only-launch.v1' as const
export const ORCHESTRATION_WORKER_OUTCOME_RECEIPT_RUNTIME_CAPABILITY =
  'orchestration-worker-outcome-receipt-v1' as const
/** `orchestration.runShow` answers `queue: true` with the Run's bounded queue summary. */
export const ORCHESTRATION_RUN_QUEUE_RUNTIME_CAPABILITY = 'orchestration.run-queue.v1' as const
// Why: only hosts with a supported process barrier may advertise canonical worker starts.
export const ORCHESTRATION_CANONICAL_START_BARRIER_RUNTIME_CAPABILITY =
  'orchestration-canonical-start-barrier-v1' as const
export const ORCHESTRATION_HUB_TASK_BINDING_RUNTIME_CAPABILITY =
  'orchestration.hub-task-binding.v1' as const
// Why: an older runtime strips unknown worker-start params, so --project would be dropped silently.
export const ORCHESTRATION_WORKER_COMPLETION_POLICY_RUNTIME_CAPABILITY =
  'orchestration.worker-completion-policy.v1' as const
export const ORCHESTRATION_WORKER_PROJECT_RUNTIME_CAPABILITY =
  'orchestration.worker-project.v1' as const
export const ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION = 2 as const
export const ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION = 3 as const
export const ORCHESTRATION_CONTRACT_VERSION = 1 as const
export const ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY = 'orchestration.contract.v1' as const
export const FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY =
  'folder-workspace.path-status.v1' as const
export const LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY =
  'linear.issue-attribute-filter.v1' as const
export const JIRA_USER_FIELDS_RUNTIME_CAPABILITY = 'jira.user-fields.v1' as const
// Older hosts silently drop source.routingMode; callers must gate an explicit mode.
export const SESSION_PREP_ROUTING_RUNTIME_CAPABILITY = 'session-prep.routing.v1' as const
export const JEV_RUBRICS_RUNTIME_CAPABILITY = 'jev.rubrics.v1' as const
// Why: an older host's strict jev.request schema refuses the three added recipes and keeps no record.
export const JEV_REQUEST_V2_RUNTIME_CAPABILITY = 'jev.request.v2' as const
export const JEV_RECORDS_RUNTIME_CAPABILITY = 'jev.records.v1' as const
export const JIRA_USER_FIELDS_UPDATE_REQUIRED_MESSAGE =
  'Creating Jira issues with user fields requires a newer OmniConsole server. Update the server and try again.'
// Why: signals the host exposes the Agent Session History scanner over RPC
// (aiVault.listSessions). Registered unconditionally for every build, so it is a
// STATIC capability advertised by getStatus() automatically — NOT a runtime
// conditional like browser.headless.v1.
export const AI_VAULT_RUNTIME_CAPABILITY = 'aiVault.v1' as const
export const AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY = 'aiVault.session-titles.v1' as const
// Why: signals a host owns browser pages with no renderer (headless serve via the
// offscreen backend). Advertised only when that backend is actually available, so
// clients never fall back to a local desktop browser tab for a remote-owned page.
export const BROWSER_HEADLESS_RUNTIME_CAPABILITY = 'browser.headless.v1' as const
export const BROWSER_SCREENCAST_RUNTIME_CAPABILITY = 'browser.screencast.v1' as const
export const BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY = 'browser.certificate-trust.v1' as const
// Why: older hosts discard browser.tabCreate's page field, so clients may only
// treat a preallocated page ID as canonical when this is advertised.
export const BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY =
  'browser.tab-create-known-id.v1' as const
export const BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY = 'browser.clientHost.v1' as const
export const BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY =
  'browser.clientHost.pageMetadata.v1' as const
export const BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY =
  'browser.clientHost.automation.v1' as const
// Why: without it a client-placed browser.upload would resolve remote paths on the desktop filesystem, so uploads fail closed instead.
export const BROWSER_CLIENT_FILE_CHANNEL_RUNTIME_CAPABILITY =
  'browser.clientHost.fileChannel.v1' as const
export const BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY = 'network.browserTunnel.v1' as const
export const BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY =
  'network.browserTunnel.executionHosts.v1' as const
// Why: hosts without this strip terminal.send's inputKind (zod object drops
// unknown keys), so a mobile xterm query reply would land as ordinary
// floor-taking input. Mobile must not forward replies unless advertised.
export const TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY =
  'terminal.query-reply-input.v1' as const
// Why: paired clients may unmount xterm only when the host can return a
// bounded, sequenced scrollback snapshot for lossless reveal.
export const TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY = 'terminal.paired-parking.v1' as const
// Why: older hosts lack the targeted settings RPCs and strip agentPrompt from
// terminal creation, so mobile must hide Quick Commands unless both are present.
export const TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY = 'terminal.quick-commands.v1' as const
// Why: older hosts strip worktree.create's clientMutationId, so mobile must only
// replay ambiguous cutovers when the host advertises idempotent create support;
// status.worktreeCreateIdempotency carries the optional host retention policy.
export const WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'worktree.create-idempotency.v1' as const
export const CODEX_RESET_CREDIT_RUNTIME_CAPABILITY = 'accounts.codex-reset-credit.v1' as const
export const ACCOUNT_IMPORT_RUNTIME_CAPABILITY = 'accounts.import-host-credentials.v1' as const
// Why: older hosts cannot reconcile terminal.create's mutation after losing the reply, so clients may only retry unknown outcomes when advertised.
export const TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'terminal.create-idempotency.v2' as const
export const SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY = 'session-tabs.close-intent.v1' as const
export const SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY =
  'session-tabs.authoritative-inventory.v1' as const
// Why: per-execution-host absence evidence (inventory `coverage`, snapshot `membershipUnverified`);
// a client that omits it keeps today's projection and reads every unlabeled omission as unknown.
export const SESSION_TABS_SCOPED_ABSENCE_RUNTIME_CAPABILITY =
  'session-tabs.scoped-absence.v1' as const
// Why: session-tab frames gain additive inventory-order metadata (runtime generation, one shared
// revision, a separate client projection revision); a host sends it only to a client that declares
// this, so an older client keeps today's epoch/version frames and comparison.
export const SESSION_TABS_INVENTORY_ORDER_RUNTIME_CAPABILITY =
  'session-tabs.inventory-order.v1' as const
// Why: the controller's workflow set rides listAll and the subscribeAll inventory (`workflowRecords`),
// later changes are `workflowRecords` events (whole sets or deltas), and `session.workflows.open`
// opens one on its controller; a client that omits it gets no field and no event.
export const SESSION_TABS_WORKFLOW_RECORDS_RUNTIME_CAPABILITY =
  'session-tabs.workflow-records.v1' as const
// Why: the owner's conversation ledger (every conversation its sidebar lists, with rest, archive
// mark, folder and title) rides listAll and the subscribeAll inventory (`conversationLedger`),
// later changes are `conversationLedger` events (whole sets or per-workspace deltas); a client that
// omits it gets no field and no event, so its frames stay byte-identical (session parity, step 1).
// Why not in RUNTIME_CAPABILITIES: a runtime's status names it only while its owner ledger
// publisher runs (startOwnerConversationLedger; never orcad), so no receiver reads an owner that
// lists nothing as one that has nothing. Clients declare it with the receiver that consumes it
// (web-session-conversation-ledger.ts).
export const SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY =
  'session-tabs.conversation-ledger.v1' as const
export const AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY =
  'agent-session.session-boundary.v1' as const
export { REMOTE_SERVER_UPDATE_CAPABILITY } from './remote-server-update'
export const AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY =
  'agent-session.host-authority.v1' as const
export const AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY =
  'agent-session.omp-resume-path.v1' as const
// Why: not in RUNTIME_CAPABILITIES; getStatus() pushes it only when account capacity services exist, so orcad never claims it.
export const AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY =
  'agent-session.verified-account-launch.v1' as const
export const AGENT_SESSION_MANAGED_TOOLS_RUNTIME_CAPABILITY =
  'agent-session.managed-tools.v1' as const
// Why: not in RUNTIME_CAPABILITIES; only the desktop with accounts runs Discover and brings its
// finished runs to OmniOS (discover-omnios-delivery.ts). OmniOS's AI-operations computer adapter
// starts a Discover for a connected AI only where the runtime says so.
export const WORKFLOW_DISCOVER_OMNIOS_RUNTIME_CAPABILITY = 'workflow.discover-omnios.v1' as const
export const WORKFLOW_DISCOVER_OMNIOS_V2_RUNTIME_CAPABILITY = 'workflow.discover-omnios.v2' as const
// Why: structured sessions are journal-backed, not PTY-backed, so a client that
// cannot read them must not see them at all — it would render an agent tab it
// can neither display nor drive. The host also refuses every agentSession.*
// method from a connection that does not advertise this.
export const STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY = 'agent-session.structured.v1' as const
// Why: mobile clients advertise Claude-structured session support during E2EE
// pairing so the desktop can keep structured-specific affordances enabled.
export const CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY =
  'agent-session.structured.claude.v1' as const
// Why: paired structured clients explicitly hold every visible session surface, allowing the host
// to stop provider children after the last surface closes without tying lifetime to a transport.
export const STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY =
  'agent-session.structured.hold.v1' as const
// Viewer holds retain a child without resuming it and report the host's process evidence.
export const STRUCTURED_AGENT_SESSION_VIEWER_HOLD_RUNTIME_CAPABILITY =
  'agent-session.structured.viewer-hold.v1' as const
// Why: a client holding only a session id — an Agent Session History row — asks the host to
// republish that chat's tab. An older host has no such method, and a client must learn that during
// negotiation rather than by calling and reading a refusal it cannot distinguish from a real one.
export const STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY =
  'agent-session.structured.reveal.v1' as const
// Why: `agentSession.create` gains an optional `resumeFrom`, and its params are a STRICT union — an
// older host rejects the unknown key as a schema error, which a client cannot tell from a real
// refusal. Worse, without probing, a client cannot know whether a host that accepted the call
// adopted the conversation or quietly started a blank one. Negotiate before offering the action.
export const STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY =
  'agent-session.structured.resume-history.v1' as const
// Why: agentSession.subscribeStatus is additive to a surface that already shipped, so a host
// advertising agent-session.structured.v1 may still answer it with method_not_found. Clients must
// probe before subscribing or they reconnect forever and never show any status at all.
export const AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY = 'agent-session.status-feed.v1' as const
// Readers must understand a monitoring roster with no available stop control.
export const AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY =
  'agent-session.background-task-stop.v1' as const
// Why: adding kimi to RESUMABLE_TUI_AGENTS grows terminal.ensureAgentSession's enum, and an
// older host answers the unknown member with invalid_argument — a code the launch fallback does
// not retry on — so clients must probe before taking the host-authority path.
export const AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY = 'agent-session.kimi-resume.v1' as const
// Why: older runtimes strip mutation owner fields, so clients must fence writes before RPC.
export const FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY = 'files.mutation-ownership.v1' as const
export const FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE =
  'Remote file changes require a newer OmniConsole server. Update the HUB and try again.'
export const GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY = 'github.markPRReadyForReview' as const
export const GITHUB_MERGE_EXPECTED_HEAD_RUNTIME_CAPABILITY =
  'github.mergePR.expected-head.v1' as const
export const GITHUB_MARK_PR_READY_UPDATE_REQUIRED_MESSAGE =
  'Marking a pull request ready requires a newer OmniConsole server. Update the server and try again.'
export const GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY =
  'gitlab.updateMR.readyForReview.v1' as const
export const GITLAB_READY_FOR_REVIEW_UPDATE_REQUIRED_MESSAGE =
  'Marking a merge request ready requires a newer OmniConsole server. Update the server and try again.'
export const WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY =
  'worktree.visibility-defaults.v1' as const
export const WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY =
  'worktree.visibility-source-defaults.v1' as const
// Why: older hosts drop automation.list's selector and answer with the whole authority, so a scoped client must not read that as one host's rows.
export const AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY =
  'automation.list-host-scope.v1' as const
export const AUTOMATION_LIST_HOST_SCOPE_UPDATE_REQUIRED_MESSAGE =
  'Filtering automations by host requires a newer OmniConsole server. Update the HUB and try again.'
// Why: without server-side owner preconditions a mutation could run against a host the user never saw, so unfenced rows stay view-only.
export const AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY = 'automation.owner-fencing.v1' as const
export const AUTOMATION_OWNER_FENCING_UPDATE_REQUIRED_MESSAGE =
  'Editing automations on this host requires a newer OmniConsole server. Update the HUB and try again.'
export const AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'automation.create-idempotency.v1' as const
export const AUTOMATION_STRUCTURED_OUTPUT_RUNTIME_CAPABILITY =
  'automation.structured-output.v1' as const
export const AUTOMATION_STRUCTURED_OUTPUT_UPDATE_REQUIRED_MESSAGE =
  'Structured decisions require a newer OmniConsole server. Update this routine’s host and try again.'

// Generic native clients include the CLI and must not claim Electron-only page
// placement support.
export const NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES = [
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  AUTOMATION_STRUCTURED_OUTPUT_RUNTIME_CAPABILITY
] as const

// Electron clients can decode client-hosted page placement; becoming a page
// host still requires the separate authenticated browser-client lease.
// The desktop's main process is the only client that builds a session host origin, so only it
// declares session host control (docs/reference/session-host-control.md).
export const ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES = [
  ...NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  SESSION_QUESTION_OWNER_ANSWER_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  ...SESSION_HOST_CLIENT_CAPABILITIES
] as const

export const RUNTIME_CAPABILITIES = [
  LAUNCH_PROVENANCE_CAPABILITY,
  SESSION_QUESTION_OWNER_ANSWER_CAPABILITY,
  'client-ui.sidebar-groups.v1',
  'accounts.login-link.v1',
  'accounts.autodiscovery.v1',
  OMNI_CONSOLE_MCP_DEFAULT_RUNTIME_CAPABILITY,
  OMNI_CONSOLE_MCP_LEGACY_RUNTIME_CAPABILITY,
  'runtime.status.compat.v1',
  'runtime.environments.v1',
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  AGENT_SESSION_EFFORT_ONLY_LAUNCH_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_OUTCOME_RECEIPT_RUNTIME_CAPABILITY,
  ORCHESTRATION_RUN_QUEUE_RUNTIME_CAPABILITY,
  OMP_OPENROUTER_ROUTING_RUNTIME_CAPABILITY,
  ORCHESTRATION_HUB_TASK_BINDING_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_PROJECT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_COMPLETION_POLICY_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_FILE_CHANNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  'terminal.binary-stream.v1',
  'terminal.multiplex.v1',
  'workspace-ports.v1',
  'mobile.tasks.v1',
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  SESSION_PROJECTS_LIST_RUNTIME_CAPABILITY,
  SESSION_FOLDER_AUTOMATIONS_RUNTIME_CAPABILITY,
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY,
  JIRA_USER_FIELDS_RUNTIME_CAPABILITY,
  SESSION_PREP_ROUTING_RUNTIME_CAPABILITY,
  JEV_RUBRICS_RUNTIME_CAPABILITY,
  JEV_REQUEST_V2_RUNTIME_CAPABILITY,
  JEV_RECORDS_RUNTIME_CAPABILITY,
  AI_VAULT_RUNTIME_CAPABILITY,
  AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY,
  TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY,
  TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY,
  TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY,
  WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  SESSION_TABS_SCOPED_ABSENCE_RUNTIME_CAPABILITY,
  SESSION_TABS_INVENTORY_ORDER_RUNTIME_CAPABILITY,
  SESSION_TABS_WORKFLOW_RECORDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  REMOTE_SERVER_UPDATE_CAPABILITY,
  AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY,
  AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_VIEWER_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY,
  AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY,
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY,
  GITHUB_MERGE_EXPECTED_HEAD_RUNTIME_CAPABILITY,
  GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
  ACCOUNT_IMPORT_RUNTIME_CAPABILITY,
  CODEX_RESET_CREDIT_RUNTIME_CAPABILITY,
  SKILL_INSTALL_CAPABILITY,
  SKILL_BUNDLE_INSTALL_CAPABILITY,
  SKILL_INSTALL_CANCEL_CAPABILITY,
  SKILL_INSTALL_PROGRESS_CAPABILITY,
  SKILL_INSTALL_RESULT_V2_CAPABILITY,
  SKILL_UPLOAD_CAPABILITY,
  SKILL_MANAGEMENT_CAPABILITY,
  SKILL_INSTALL_PROVIDERS_CAPABILITY,
  SKILL_DELETE_CAPABILITY,
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  AUTOMATION_STRUCTURED_OUTPUT_RUNTIME_CAPABILITY
] as const

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number] | (string & {})

// COMPAT(mobileProtocolAliases): added 2026-05-15 for mobile builds that
// still read desktop/mobile names; remove once mobile reads runtime names.
export const DESKTOP_PROTOCOL_VERSION = RUNTIME_PROTOCOL_VERSION
export const MIN_COMPATIBLE_MOBILE_VERSION = MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
