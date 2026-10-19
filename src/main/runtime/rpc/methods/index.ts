import { SSH_NATIVE_CHAT_READ } from './native-chat-ssh'
import type { RpcAnyMethod } from '../core'
import { STATUS_METHODS } from './status'
import { AI_VAULT_METHODS } from './ai-vault'
import { SESSION_SEARCH_METHODS } from './session-search'
import { AUTOMATION_METHODS } from './automations'
import { STRUCTURED_DECISION_METHODS } from './structured-decisions'
import { JEV_CONTROL_RPC_METHODS } from './jev-control'
import { JEV_RUBRIC_RPC_METHODS } from './jev-rubrics'
import { JEV_RECORD_RPC_METHODS } from './jev-records'
import { AGENT_TEMPLATE_METHODS } from './agent-templates'
import { BUILD_REVIEW_METHODS } from './build-review'
import { EVOLVE_METHODS } from './evolve'
import { CONSOLE_AUTO_ADVANCE_METHODS } from './console-auto-advance'
import { LOCAL_RUN_METHODS } from './local-runs'
import { LOCAL_WORKFLOW_RPC_METHODS } from './local-workflow'
import { WORKFLOW_SCRIPT_METHODS } from './workflow-script'
import { REPO_METHODS } from './repo'
import { WORKTREE_METHODS } from './worktree'
import { TERMINAL_METHODS } from './terminal'
import { TERMINAL_ORPHAN_METHODS } from './terminal-orphan'
import { BROWSER_CORE_METHODS } from './browser-core'
import { BROWSER_EXTRA_METHODS } from './browser-extras'
import { BROWSER_SCREENCAST_METHODS } from './browser-screencast'
import { BROWSER_CLIENT_HOST_METHODS } from './browser-client-host'
import { BROWSER_CLIENT_FILE_CHANNEL_METHODS } from './browser-client-file-channel'
import { BROWSER_NETWORK_TUNNEL_METHODS } from './browser-network-tunnel'
import { ORCHESTRATION_METHODS } from './orchestration'
import { NOTIFICATION_METHODS } from './notifications'
import { STATS_METHODS } from './stats'
import { DIAGNOSTICS_METHODS } from './diagnostics'
import { WORK_DELIVERY_METHODS } from './work-delivery'
import { ACCOUNT_METHODS } from './accounts'
import { SELECTED_ACCOUNT_USAGE_METHODS } from './selected-account-usage'
import { PREFLIGHT_METHODS } from './preflight'
import { COMPUTER_METHODS } from './computer'
import { SESSION_TAB_METHODS } from './session-tabs'
import { SESSION_CHAIN_METHODS } from './session-chains'
import { WORK_PLAN_VIEW_METHODS } from './work-plan-view'
import { WORK_PLAN_PROPOSE_METHODS } from './work-plan-propose'
import { PROMPT_QUEUE_METHODS } from './prompt-queue'
import { NEXT_STEPS_METHODS } from './next-steps'
import { SESSION_FOLDER_METHODS } from './session-folders'
import { SESSION_PROJECT_METHODS } from './session-projects'
import { SESSION_ORGANIZATION_METHODS } from './session-organization'
import { IDLE_AUTO_CLOSE_METHODS } from './idle-auto-close'
import { SESSION_ORGANIZATION_OWNERSHIP_METHODS } from './session-organization-ownership'
import { SESSION_ORGANIZATION_HOST_METHODS } from './session-organization-host'
import { SESSION_ORGANIZE_METHOD } from './session-organization-organize'
import { SESSION_QUESTIONS_METHOD } from './session-questions'
import { SESSION_DECISIONS_METHODS } from './session-decisions'
import { SESSION_STEWARD_STATUS_METHODS } from './session-steward-status'
import { SESSION_HOSTS_STATUS_METHODS } from './session-hosts-status'
import { SESSION_HOSTS_ARCHIVE_METHODS } from './session-hosts-archive'
import { SESSION_HOSTS_LEDGER_SNAPSHOT_METHODS } from './session-hosts-ledger-snapshots'
import { SESSION_FRAME_LOG_METHODS } from './session-frame-log'
import { SESSION_LEDGER_METHODS } from './session-ledger'
import { SESSION_MANAGE_RELOCATE_METHODS } from './session-manage-relocate'
import { SESSION_STEWARD_SUGGESTION_METHODS } from './session-steward-suggestions'
import { SESSION_MANAGE_METHODS } from './session-manage'
import { SESSION_OWNER_PAUSE_METHOD } from './session-owner-pause'
import { SESSION_HOST_METHODS } from './session-host'
import { SESSION_QUESTION_OWNER_METHODS } from './session-question-owner-answer'
import { SESSION_MANAGE_REUSE_METHODS } from './session-manage-reuse-methods'
import { SESSION_CLEANUP_METHODS } from './session-steward-cleanup'
import { WORK_PLAN_LAYOUTS_METHODS } from './work-plan-layouts'
import { UP_NEXT_METHODS } from './up-next'
import { SESSION_PREP_METHODS } from './session-prep'
import { NATIVE_CHAT_METHODS } from './native-chat'
import { NATIVE_CHAT_TRANSCRIPT_PAGE_METHOD } from './native-chat-transcript-page'
import { TRANSCRIPT_METHODS } from './transcripts'
import { FILE_METHODS } from './files'
import { GIT_METHODS } from './git'
import { GITHUB_METHODS } from './github'
import { GITLAB_METHODS } from './gitlab'
import { HOSTED_REVIEW_METHODS } from './hosted-review'
import { LINEAR_METHODS } from './linear'
import { LINEAR_AGENT_ACCESS_METHODS } from './linear-agent-access'
import { JIRA_METHODS } from './jira'
import { SSH_METHODS } from './ssh'
import { SPEECH_METHODS } from './speech'
import { CLIENT_UI_METHODS } from './client-ui'
import { CLIENT_EVENT_METHODS } from './client-events'
import { WORKSPACE_PORT_METHODS } from './workspace-ports'
import { PLUGIN_METHODS } from './plugins'
import { SKILL_METHODS } from './skills'
import { CLIPBOARD_METHODS } from './clipboard'
import { HOST_CAPABILITY_METHODS } from './host-capabilities'
import { EMULATOR_METHODS } from './emulator'
import { PAIRING_METHODS } from './pairing'
import { UPDATER_METHODS } from './updater'
import { AGENT_SESSION_METHODS } from './agent-session'
import { AGENT_SESSION_CONTRACT_METHODS } from './agent-session-contract'
import { AGENT_LAUNCH_READINESS_METHODS } from './agent-launch-readiness'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import { ARTIFACT_METHODS } from './artifacts'
import { SPEC_PR_BATCH_METHODS } from './spec-pr-batch'
import { AGENT_HOOK_METHODS } from './agent-hooks'

// Why: a flat manifest keeps registration order explicit and provides one
// grep-point for "what methods does the RPC server expose?" — useful when
// auditing the security boundary or wiring new CLI commands.
export const ALL_RPC_METHODS: readonly RpcAnyMethod[] = [
  ...STATUS_METHODS,
  ...AGENT_HOOK_METHODS,
  ...AI_VAULT_METHODS,
  ...SESSION_SEARCH_METHODS,
  ...ARTIFACT_METHODS,
  ...SPEC_PR_BATCH_METHODS,
  ...AUTOMATION_METHODS,
  ...STRUCTURED_DECISION_METHODS,
  ...JEV_CONTROL_RPC_METHODS,
  ...JEV_RUBRIC_RPC_METHODS,
  ...JEV_RECORD_RPC_METHODS,
  ...AGENT_TEMPLATE_METHODS,
  ...BUILD_REVIEW_METHODS,
  ...EVOLVE_METHODS,
  ...CONSOLE_AUTO_ADVANCE_METHODS,
  ...LOCAL_RUN_METHODS,
  ...LOCAL_WORKFLOW_RPC_METHODS,
  ...WORKFLOW_SCRIPT_METHODS,
  ...REPO_METHODS,
  ...WORKTREE_METHODS,
  ...AGENT_SESSION_METHODS,
  ...AGENT_SESSION_CONTRACT_METHODS,
  ...AGENT_LAUNCH_READINESS_METHODS,
  ...STRUCTURED_AGENT_SESSION_METHODS,
  ...TERMINAL_METHODS,
  ...TERMINAL_ORPHAN_METHODS,
  ...BROWSER_CORE_METHODS,
  ...BROWSER_SCREENCAST_METHODS,
  ...BROWSER_EXTRA_METHODS,
  ...BROWSER_CLIENT_HOST_METHODS,
  ...BROWSER_CLIENT_FILE_CHANNEL_METHODS,
  ...BROWSER_NETWORK_TUNNEL_METHODS,
  ...ORCHESTRATION_METHODS,
  ...NOTIFICATION_METHODS,
  ...STATS_METHODS,
  ...DIAGNOSTICS_METHODS,
  ...WORK_DELIVERY_METHODS,
  ...ACCOUNT_METHODS,
  ...SELECTED_ACCOUNT_USAGE_METHODS,
  ...PREFLIGHT_METHODS,
  ...COMPUTER_METHODS,
  ...SESSION_TAB_METHODS,
  ...SESSION_CHAIN_METHODS,
  ...WORK_PLAN_VIEW_METHODS,
  ...WORK_PLAN_PROPOSE_METHODS,
  ...PROMPT_QUEUE_METHODS,
  ...NEXT_STEPS_METHODS,
  ...SESSION_FOLDER_METHODS,
  ...SESSION_PROJECT_METHODS,
  ...SESSION_ORGANIZATION_METHODS,
  ...IDLE_AUTO_CLOSE_METHODS,
  ...SESSION_ORGANIZATION_OWNERSHIP_METHODS,
  ...SESSION_ORGANIZATION_HOST_METHODS,
  SESSION_ORGANIZE_METHOD,
  SESSION_QUESTIONS_METHOD,
  ...SESSION_DECISIONS_METHODS,
  ...SESSION_STEWARD_STATUS_METHODS,
  ...SESSION_HOSTS_STATUS_METHODS,
  ...SESSION_HOSTS_ARCHIVE_METHODS,
  ...SESSION_HOSTS_LEDGER_SNAPSHOT_METHODS,
  ...SESSION_FRAME_LOG_METHODS,
  ...SESSION_LEDGER_METHODS,
  ...SESSION_MANAGE_RELOCATE_METHODS,
  ...SESSION_STEWARD_SUGGESTION_METHODS,
  ...SESSION_MANAGE_METHODS,
  SESSION_OWNER_PAUSE_METHOD,
  ...SESSION_HOST_METHODS,
  ...SESSION_QUESTION_OWNER_METHODS,
  ...SESSION_MANAGE_REUSE_METHODS,
  ...SESSION_CLEANUP_METHODS,
  ...WORK_PLAN_LAYOUTS_METHODS,
  ...UP_NEXT_METHODS,
  ...SESSION_PREP_METHODS,
  ...NATIVE_CHAT_METHODS,
  SSH_NATIVE_CHAT_READ,
  NATIVE_CHAT_TRANSCRIPT_PAGE_METHOD,
  ...TRANSCRIPT_METHODS,
  ...FILE_METHODS,
  ...GIT_METHODS,
  ...GITHUB_METHODS,
  ...GITLAB_METHODS,
  ...HOSTED_REVIEW_METHODS,
  ...LINEAR_METHODS,
  ...LINEAR_AGENT_ACCESS_METHODS,
  ...JIRA_METHODS,
  ...SSH_METHODS,
  ...SPEECH_METHODS,
  ...WORKSPACE_PORT_METHODS,
  ...PLUGIN_METHODS,
  ...SKILL_METHODS,
  ...CLIPBOARD_METHODS,
  ...HOST_CAPABILITY_METHODS,
  ...CLIENT_EVENT_METHODS,
  ...CLIENT_UI_METHODS,
  ...EMULATOR_METHODS,
  ...PAIRING_METHODS,
  ...UPDATER_METHODS
]
