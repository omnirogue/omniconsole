import { resolveOpenRouterCredential } from '../../structured-decisions/decision-credential'
import { OPENROUTER_WORKER_SCRIPT } from './workflow-openrouter-worker'
import { workflowOllamaCommand } from './workflow-ollama-launch'
import { workflowCallTimeoutMs } from './workflow-call-timeout'
import { access, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import {
  workflowAgentInstructions,
  type WorkflowAgentAccess,
  type WorkflowAgentOutput
} from '../../../shared/workflow-agent-instructions'
import {
  buildWorkflowClaudeArgs,
  buildWorkflowClaudeStreamArgs,
  WORKFLOW_CLAUDE_STREAM_ENVIRONMENT
} from '../../../shared/workflow-claude-command'
import {
  buildWorkflowCodexArgs,
  buildWorkflowCodexStreamArgs
} from '../../../shared/workflow-codex-command'
import {
  buildWorkflowGeminiArgs,
  buildWorkflowGeminiSystemSettings,
  workflowGeminiEnvironment,
  workflowGeminiSystemPrompt,
  WORKFLOW_GEMINI_ADMIN_POLICY
} from '../../../shared/workflow-gemini-command'
import { WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS } from '../../../shared/workflow-grok-command'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { WorkflowAttemptLaunch } from './workflow-durable-call'
import type { WorkflowProgramCall } from './workflow-program-context'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import {
  COUNCIL_REVISION,
  DISCOVER_REVISION,
  GRAPH_PROGRAM_REVISION
} from './workflow-program-revisions'
import { accountEnvironment } from './local-workflow-provider-catalog'
import { workflowCliModel } from './local-workflow-models'
import { workflowStrictSchema } from './workflow-strict-schema'
import { legacyGrokCommand, streamGrokCommand } from './local-workflow-grok-launch'
import { assertWorkflowReadableRoot, workflowCodexHiddenPaths } from './local-workflow-read-scope'
import { isSupportedAuditRevision } from './audit/audit-program-revision'

type LaunchInput = Parameters<WorkflowAttemptLaunch>[0]

export type WorkflowLaunchMode = {
  access: WorkflowAgentAccess
  output: WorkflowAgentOutput
  /** False only for legacy frozen schema calls, which keep their original argv byte for byte. */
  stream: boolean
  /** The verified workspace root, for workspace-read launches. */
  root?: string
}

export type WorkflowLaunchCommand = {
  program: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  input?: string
  /** Runs once the process has exited, whatever the outcome. */
  settle?: () => Promise<void>
}

export function workflowLaunchMode(
  snapshot: Pick<LocalWorkflowHostSnapshot, 'access'>,
  call: Pick<WorkflowProgramCall, 'output'>
): WorkflowLaunchMode {
  const access = snapshot.access === 'workspace-read' ? 'workspace-read' : 'frozen'
  const output = call.output === 'text' ? 'text' : 'schema'
  return { access, output, stream: access === 'workspace-read' || output === 'text' }
}

type LaunchSnapshot = Pick<
  LocalWorkflowHostSnapshot,
  'access' | 'councilProgramRevision' | 'discoverProgramRevision' | 'graphProgramRevision'
> & { audit?: { version: number } }

/**
 * Frozen Council revisions 1-4 and Discover 1-5 replay their original prompts byte for byte; only
 * Council 6, Discover 7, supported Audit revisions or workspace-read runs get retry notes. Working
 * revisions (Council 5, Discover 6) never launch through this adapter.
 */
export function workflowCurrentProgram(snapshot: LaunchSnapshot): boolean {
  return (
    snapshot.access === 'workspace-read' ||
    isSupportedAuditRevision(snapshot.audit?.version) ||
    snapshot.councilProgramRevision === COUNCIL_REVISION ||
    snapshot.discoverProgramRevision === DISCOVER_REVISION ||
    snapshot.graphProgramRevision === GRAPH_PROGRAM_REVISION
  )
}

/** A retry tells the model what was wrong; the call's identity keeps the original prompt. */
export function workflowLaunchPrompt(prompt: string, rejection: string | null | undefined): string {
  const problem = rejection
    ?.trim()
    .replace(/[.\s]+$/, '')
    .slice(0, 2_000)
  return problem
    ? `${prompt}\n\nYour previous answer was rejected: ${problem}. Answer again and fix that.`
    : prompt
}

async function codexCommand(
  seat: ResolvedLocalWorkflowSeat,
  input: LaunchInput,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  mode: WorkflowLaunchMode
): Promise<WorkflowLaunchCommand> {
  const source = env.CODEX_HOME
  if (!source) {
    throw new Error('The selected Codex account is unavailable.')
  }
  const operationHome = join(cwd, 'codex-home')
  await mkdir(operationHome, { mode: 0o700 })
  await access(join(source, 'auth.json'))
  await symlink(join(source, 'auth.json'), join(operationHome, 'auth.json'))
  for (const name of ['requirements.toml', 'managed_config.toml']) {
    try {
      await access(join(source, name))
    } catch {
      continue
    }
    await symlink(join(source, name), join(operationHome, name))
  }
  const schemaPath = join(cwd, 'schema.json')
  const instructionsPath = join(cwd, 'instructions.md')
  if (mode.output === 'schema') {
    await writeFile(schemaPath, JSON.stringify(workflowStrictSchema(input.call.schema)), {
      mode: 0o600
    })
  }
  await writeFile(
    instructionsPath,
    mode.stream
      ? workflowAgentInstructions(mode.access, mode.output)
      : WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS,
    { mode: 0o600 }
  )
  const model = workflowCliModel('codex', seat.model)
  const effort = seat.effort ?? 'medium'
  if (!mode.stream) {
    return {
      program: 'codex',
      args: buildWorkflowCodexArgs({ model, effort, schemaPath, instructionsPath }),
      cwd,
      env: { ...env, CODEX_HOME: operationHome },
      input: prompt
    }
  }
  const streamEnv: NodeJS.ProcessEnv = { ...env, CODEX_HOME: operationHome }
  if (mode.root) {
    // An empty ZDOTDIR: zsh would otherwise source ~/.zshenv, which may export tokens.
    streamEnv.ZDOTDIR = join(cwd, 'shell')
    await mkdir(streamEnv.ZDOTDIR, { mode: 0o700 })
  }
  return {
    program: 'codex',
    args: buildWorkflowCodexStreamArgs({
      model,
      effort,
      instructionsPath,
      ...(mode.output === 'schema' ? { schemaPath } : {}),
      ...(mode.root
        ? { workspaceRoot: mode.root, hiddenPaths: await workflowCodexHiddenPaths(mode.root) }
        : {})
    }),
    cwd,
    env: streamEnv,
    input: prompt
  }
}

async function geminiCommand(
  seat: ResolvedLocalWorkflowSeat,
  input: LaunchInput,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  mode: WorkflowLaunchMode
): Promise<WorkflowLaunchCommand> {
  // Everything Gemini writes (settings, session logs, error reports) lands under the attempt.
  const home = join(cwd, 'gemini-home')
  const tmp = join(cwd, 'tmp')
  await mkdir(join(home, '.gemini'), { recursive: true, mode: 0o700 })
  await mkdir(tmp, { mode: 0o700 })
  await writeFile(join(home, '.gemini', 'settings.json'), '{}', { mode: 0o600 })
  const systemSettings = join(cwd, 'system-settings.json')
  const systemPrompt = join(cwd, 'system.md')
  const adminPolicyPath = join(cwd, 'admin-policy.toml')
  await writeFile(
    systemSettings,
    buildWorkflowGeminiSystemSettings({
      model: seat.model,
      effort: seat.effort,
      access: mode.access,
      ...(mode.output === 'schema' ? { schema: input.call.schema } : {})
    }),
    { mode: 0o600 }
  )
  await writeFile(systemPrompt, workflowGeminiSystemPrompt(mode.access, mode.output), {
    mode: 0o600
  })
  await writeFile(adminPolicyPath, WORKFLOW_GEMINI_ADMIN_POLICY, { mode: 0o600 })
  let workdir = mode.root
  if (!workdir) {
    workdir = join(cwd, 'empty')
    await mkdir(workdir, { mode: 0o700 })
  }
  return {
    program: 'gemini',
    args: buildWorkflowGeminiArgs({
      model: workflowCliModel('gemini', seat.model),
      attemptId: input.attemptId,
      adminPolicyPath
    }),
    cwd: workdir,
    env: {
      ...env,
      ...workflowGeminiEnvironment({
        home,
        systemSettings,
        // Deliberately absent: no machine-wide defaults layer applies.
        systemDefaults: join(cwd, 'system-defaults.json'),
        systemPrompt,
        tmp
      })
    },
    input: prompt
  }
}

/** Private per-attempt files live under `<directory>/inputs/<attemptId>`, never in the workspace. */
export async function workflowLaunchCommand(
  runtime: OrcaRuntimeService,
  snapshot: LaunchSnapshot,
  seat: ResolvedLocalWorkflowSeat,
  input: LaunchInput,
  directory: string,
  mode: WorkflowLaunchMode
): Promise<WorkflowLaunchCommand> {
  if (mode.root) {
    // Start refuses such a folder too; this also covers runs admitted before that check.
    await assertWorkflowReadableRoot(mode.root)
  }
  const cwd = join(directory, 'inputs', input.attemptId)
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  const env = accountEnvironment(runtime, seat, snapshot.access)
  const prompt = workflowLaunchPrompt(
    input.call.prompt,
    workflowCurrentProgram(snapshot) ? input.rejection : null
  )
  if (seat.agent === 'openrouter') {
    const key = await resolveOpenRouterCredential()
    if (!key) {
      throw new Error('Add OPENROUTER_API_KEY to ~/.config/omni/connections.env')
    }
    return {
      program: process.execPath,
      args: ['-e', OPENROUTER_WORKER_SCRIPT],
      cwd,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1', OPENROUTER_API_KEY: key },
      input: JSON.stringify({
        model: seat.model,
        attemptId: input.attemptId,
        prompt,
        ...(mode.output === 'schema' ? { schema: input.call.schema } : {}),
        mode: mode.access,
        root: mode.root,
        maxTokens: 8192,
        timeoutMs:
          workflowCallTimeoutMs(input.call.timeoutMs) ??
          (mode.access === 'workspace-read' ? 900_000 : 120_000)
      })
    }
  }
  if (seat.agent === 'ollama') {
    return await workflowOllamaCommand({ model: seat.model, input, prompt, mode, cwd, env })
  }
  if (seat.agent === 'codex') {
    return await codexCommand(seat, input, cwd, env, prompt, mode)
  }
  if (seat.agent === 'grok') {
    return mode.stream
      ? await streamGrokCommand(seat, input, cwd, env, prompt, mode)
      : await legacyGrokCommand(seat, input, cwd, env, prompt)
  }
  if (seat.agent === 'gemini') {
    return await geminiCommand(seat, input, cwd, env, prompt, mode)
  }
  const model = workflowCliModel('claude', seat.model)
  const effort = seat.effort ?? undefined
  if (!mode.stream) {
    const args = buildWorkflowClaudeArgs({
      model,
      effort,
      attemptId: input.attemptId,
      schema: input.call.schema
    })
    return { program: 'claude', args, cwd, env, input: prompt }
  }
  return {
    program: 'claude',
    args: buildWorkflowClaudeStreamArgs({
      model,
      effort,
      attemptId: input.attemptId,
      access: mode.access,
      ...(mode.output === 'schema' ? { schema: input.call.schema } : {})
    }),
    // Claude's file tools resolve against its working directory, so it runs in the workspace.
    cwd: mode.root ?? cwd,
    env: { ...env, ...WORKFLOW_CLAUDE_STREAM_ENVIRONMENT },
    input: prompt
  }
}
