import type { CommandSpec } from '../args'
import { OUTCOME_SPECS } from './outcome'
import { TERMINAL_PEER_INBOX_COMMAND_SPECS } from './terminal-peer-inbox'
import { ACCOUNT_COMMAND_SPECS } from './account'
import { BROWSER_ADVANCED_COMMAND_SPECS } from './browser-advanced'
import { BROWSER_BASIC_COMMAND_SPECS } from './browser-basic'
import { AUTOMATION_COMMAND_SPECS } from './automations'
import { CORE_COMMAND_SPECS } from './core'
import { FILE_COMMAND_SPECS } from './file'
import { PROJECT_COMMAND_SPECS } from './project'
import { ORCHESTRATION_COMMAND_SPECS } from './orchestration'
import { COMPUTER_COMMAND_SPECS } from './computer'
import { ENVIRONMENT_COMMAND_SPECS } from './environment'
import { AGENT_HOOK_COMMAND_SPECS } from './agent-hooks'
import { ANSWERS_COMMAND_SPECS } from './answers'
import { DIAGNOSTICS_COMMAND_SPECS } from './diagnostics'
import { WORK_COMMAND_SPECS } from './work'
import { EMULATOR_COMMAND_SPECS } from './emulator'
import { INTROSPECTION_COMMAND_SPECS } from './introspection'
import { LINEAR_COMMAND_SPECS } from './linear'
import { VM_COMMAND_SPECS } from './vm'
import { SKILL_COMMAND_SPECS } from './skills'
import { ARTIFACT_COMMAND_SPECS } from './artifacts'
import { PROMPT_QUEUE_COMMAND_SPECS } from './prompt-queue'
import { SESSION_FOLDER_COMMAND_SPECS } from './session-folders'
import { SESSION_PROJECT_COMMAND_SPECS } from './session-projects'
import { SESSION_MANAGE_COMMAND_SPECS } from './session-manage'
import { SESSION_FRAME_LOG_COMMAND_SPECS } from './session-frame-log'
import { SESSION_LEDGER_COMMAND_SPECS } from './session-ledger'
import { SESSION_ORGANIZE_COMMAND_SPECS } from './session-organize'
import { SESSION_SEARCH_COMMAND_SPECS } from './session-search'
import { SESSION_REUSE_COMMAND_SPECS } from './session-reuse'
import { SESSION_LAUNCH_COMMAND_SPECS } from './session-launch'
import { SESSION_PREPARE_COMMAND_SPECS } from './session-prepare'
import { SESSION_QUESTIONS_COMMAND_SPECS } from './session-questions'
import { FIND_BEST_COMMAND_SPECS } from './find-best'
import { WORKFLOW_RUN_COMMAND_SPECS } from './workflow-run'
import { WORKFLOW_DECISION_PAGE_SPECS } from './workflow-decision-page'
import { WORKFLOW_STATS_COMMAND_SPECS } from './workflow-stats'
import { JEV_COMMAND_SPECS } from './jev'
import { AGENT_TEMPLATE_COMMAND_SPECS } from './agents'

export const COMMAND_SPECS: CommandSpec[] = [
  ...CORE_COMMAND_SPECS,
  ...OUTCOME_SPECS,
  ...TERMINAL_PEER_INBOX_COMMAND_SPECS,
  ...ARTIFACT_COMMAND_SPECS,
  ...ACCOUNT_COMMAND_SPECS,
  ...PROJECT_COMMAND_SPECS,
  ...FILE_COMMAND_SPECS,
  ...AUTOMATION_COMMAND_SPECS,
  ...BROWSER_BASIC_COMMAND_SPECS,
  ...BROWSER_ADVANCED_COMMAND_SPECS,
  ...ORCHESTRATION_COMMAND_SPECS,
  ...COMPUTER_COMMAND_SPECS,
  ...AGENT_HOOK_COMMAND_SPECS,
  ...ANSWERS_COMMAND_SPECS,
  ...DIAGNOSTICS_COMMAND_SPECS,
  ...WORK_COMMAND_SPECS,
  ...INTROSPECTION_COMMAND_SPECS,
  ...ENVIRONMENT_COMMAND_SPECS,
  ...LINEAR_COMMAND_SPECS,
  ...VM_COMMAND_SPECS,
  ...EMULATOR_COMMAND_SPECS,
  ...SKILL_COMMAND_SPECS,
  ...PROMPT_QUEUE_COMMAND_SPECS,
  ...SESSION_FOLDER_COMMAND_SPECS,
  ...SESSION_PROJECT_COMMAND_SPECS,
  ...SESSION_MANAGE_COMMAND_SPECS,
  ...SESSION_FRAME_LOG_COMMAND_SPECS,
  ...SESSION_LEDGER_COMMAND_SPECS,
  ...SESSION_ORGANIZE_COMMAND_SPECS,
  ...SESSION_SEARCH_COMMAND_SPECS,
  ...SESSION_REUSE_COMMAND_SPECS,
  ...SESSION_LAUNCH_COMMAND_SPECS,
  ...SESSION_PREPARE_COMMAND_SPECS,
  ...SESSION_QUESTIONS_COMMAND_SPECS,
  ...FIND_BEST_COMMAND_SPECS,
  ...WORKFLOW_RUN_COMMAND_SPECS,
  ...WORKFLOW_STATS_COMMAND_SPECS,
  ...WORKFLOW_DECISION_PAGE_SPECS,
  ...JEV_COMMAND_SPECS,
  ...AGENT_TEMPLATE_COMMAND_SPECS
]
