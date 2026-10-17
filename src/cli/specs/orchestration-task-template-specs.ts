import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const TEMPLATE_IDS = 'implement, independent-review, deterministic-qa, release or live-verification'

export const ORCHESTRATION_TASK_CREATE_SPEC: CommandSpec = {
  path: ['orchestration', 'task-create'],
  summary: 'Create an orchestration task',
  usage:
    'omni orchestration task-create (--spec <text> | --template <id> [--field <key=value>]... [--fields-file <json>] [--print-spec] [--no-verify]) [--task-title <text>] [--display-name <text>] [--deps <json_array>] [--parent <task_id>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'spec',
    'template',
    'field',
    'fields-file',
    'print-spec',
    'no-verify',
    'task-title',
    'display-name',
    'deps',
    'parent',
    'run',
    'from',
    'retry-request'
  ],
  notes: [
    `--template renders a production brief (${TEMPLATE_IDS}) from --field key=value pairs and an optional --fields-file JSON object; a --field wins over the file. A missing or placeholder field is refused and no task is created.`,
    '--print-spec prints the rendered brief and creates nothing. A template shapes the brief only: it never dispatches, approves, accepts or releases.',
    '--template implement also creates a verify task that waits on it: the same Acceptance lines, re-run read-only by a worker who did not write the work. Dispatch it to a different worker, and forward its FAIL lines to the implementer exactly as written. --no-verify skips it.'
  ]
}

export const ORCHESTRATION_TASK_TEMPLATES_SPEC: CommandSpec = {
  path: ['orchestration', 'task-templates'],
  summary: 'List the production task templates, or show one with its fields',
  usage: 'omni orchestration task-templates [--template <id>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'template'],
  notes: ['Read-only and local: it needs no running OmniConsole.']
}

/** Help lines for the flags only the task template commands take. */
export const ORCHESTRATION_TASK_TEMPLATE_FLAG_HELP: Readonly<Record<string, string>> = {
  template: `--template <id>       ${TEMPLATE_IDS}`,
  field: '--field <key=value>   One template field; repeat for each field',
  'fields-file': '--fields-file <path>  JSON object of template fields',
  'print-spec': '--print-spec          Print the rendered brief and create nothing',
  'no-verify': '--no-verify           Do not add the verify task an implement task gets by default'
}
