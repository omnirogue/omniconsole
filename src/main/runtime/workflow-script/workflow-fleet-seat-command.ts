import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import type { WorkflowPlacement } from '../../../shared/local-workflow-placement'
import { workflowAgentInstructions } from '../../../shared/workflow-agent-instructions'
import {
  buildWorkflowClaudeArgs,
  buildWorkflowClaudeStreamArgs,
  WORKFLOW_CLAUDE_STREAM_ENVIRONMENT
} from '../../../shared/workflow-claude-command'
import {
  buildWorkflowCodexArgs,
  buildWorkflowCodexStreamArgs
} from '../../../shared/workflow-codex-command'
import { WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS } from '../../../shared/workflow-grok-command'
import { workflowCliModel } from './local-workflow-models'
import type { WorkflowLaunchMode } from './local-workflow-provider-commands'
import type { WorkflowFleetSeatRoute } from './workflow-fleet-host-probe'
import {
  WORKFLOW_FLEET_UNSET_API_KEYS,
  workflowFleetShellQuote
} from './workflow-fleet-remote-shell'

/** A placement with a host to dispatch to and its run folder there. */
export type WorkflowFleetDispatched = WorkflowPlacement & {
  mode: 'dispatched-seats'
  host: NonNullable<WorkflowPlacement['host']> & { ssh: string }
  dispatch: NonNullable<WorkflowPlacement['dispatch']>
}

/** The backstop on the host: the seat's CLI ends a minute after this computer gives up on it. */
const REMOTE_ALARM_MARGIN_S = 60

/** The command one seat's CLI runs as on the host, with the files it reads written first. */
export type WorkflowFleetSeatCommand = {
  /** The attempt's own folder on the host (never reused: created exclusively). */
  directory: string
  script: string
}

/**
 * The shell script that starts one seat on the host: an exclusive attempt folder, the private
 * files the CLI reads, a Codex home linked to the host's own login, API key variables unset, the
 * pid recorded (every step execs, so it is the CLI's), and an alarm as the host-side backstop.
 * The prompt arrives on stdin through SSH.
 */
export function workflowFleetSeatCommand(input: {
  placement: WorkflowFleetDispatched
  seat: ResolvedLocalWorkflowSeat & { agent: WorkflowFleetSeatRoute }
  attemptId: string
  mode: WorkflowLaunchMode
  schema: unknown
  timeoutMs: number
}): WorkflowFleetSeatCommand {
  const { dispatch } = input.placement
  const directory = `${dispatch.root}/attempts/${input.attemptId}`
  const q = workflowFleetShellQuote
  const lines = ['set -e', 'umask 077', `d=${q(directory)}`, 'mkdir "$d"', 'cd "$d"']
  let program: string
  let args: string[]
  let cwd = directory
  const env: Record<string, string> = {}
  if (input.seat.agent === 'codex') {
    const model = workflowCliModel('codex', input.seat.model)
    const effort = input.seat.effort ?? 'medium'
    const schemaPath = `${directory}/schema.json`
    const instructionsPath = `${directory}/instructions.md`
    if (input.mode.output === 'schema') {
      lines.push(`printf '%s' ${q(JSON.stringify(input.schema))} > schema.json`)
    }
    lines.push(
      `printf '%s' ${q(
        input.mode.stream
          ? workflowAgentInstructions(input.mode.access, input.mode.output)
          : WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS
      )} > instructions.md`,
      'src="${CODEX_HOME:-$HOME/.codex}"',
      'mkdir codex-home',
      'ln -s "$src/auth.json" codex-home/auth.json',
      'for n in requirements.toml managed_config.toml; do if [ -e "$src/$n" ]; then ln -s "$src/$n" "codex-home/$n"; fi; done'
    )
    env.CODEX_HOME = `${directory}/codex-home`
    program = 'codex'
    args = !input.mode.stream
      ? buildWorkflowCodexArgs({ model, effort, schemaPath, instructionsPath })
      : buildWorkflowCodexStreamArgs({
          model,
          effort,
          instructionsPath,
          ...(input.mode.output === 'schema' ? { schemaPath } : {}),
          ...(input.mode.root
            ? { workspaceRoot: input.mode.root, hiddenPaths: dispatch.hidden }
            : {})
        })
    if (input.mode.root) {
      // An empty ZDOTDIR: zsh would otherwise source ~/.zshenv, which may export tokens.
      lines.push('mkdir shell')
      env.ZDOTDIR = `${directory}/shell`
    }
  } else {
    const model = workflowCliModel('claude', input.seat.model)
    const effort = input.seat.effort ?? undefined
    program = 'claude'
    if (!input.mode.stream) {
      args = buildWorkflowClaudeArgs({
        model,
        effort,
        attemptId: input.attemptId,
        schema: input.schema as Parameters<typeof buildWorkflowClaudeArgs>[0]['schema']
      })
    } else {
      args = buildWorkflowClaudeStreamArgs({
        model,
        effort,
        attemptId: input.attemptId,
        access: input.mode.access,
        ...(input.mode.output === 'schema'
          ? {
              schema: input.schema as Parameters<typeof buildWorkflowClaudeStreamArgs>[0]['schema']
            }
          : {})
      })
      Object.assign(env, WORKFLOW_CLAUDE_STREAM_ENVIRONMENT)
      // Claude's file tools resolve against its working directory, so it runs in the copy.
      cwd = input.mode.root ?? directory
    }
  }
  const seconds = Math.ceil(input.timeoutMs / 1000) + REMOTE_ALARM_MARGIN_S
  lines.push(
    WORKFLOW_FLEET_UNSET_API_KEYS,
    ...Object.entries(env).map(([key, value]) => `export ${key}=${q(value)}`),
    'mkdir "$d/launch-guard"',
    'test ! -e "$d/stopped"',
    `printf '%s\\n' "$$" > pid`,
    'ps -p "$$" -o lstart= > started',
    'rmdir "$d/launch-guard"',
    `cd ${q(cwd)}`,
    `exec perl -e 'alarm shift @ARGV; exec @ARGV or die "exec: $!\\n"' ${seconds} ${[program, ...args].map(q).join(' ')}`
  )
  return { directory, script: lines.join('\n') }
}
