import { mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import type { LocalWorkflowRoute } from '../../../shared/local-workflow-seats'
import { localWorkflowProviderLabel } from '../../../shared/local-workflow-model-label'
import { buildWorkflowGrokProjectConfig } from '../../../shared/workflow-grok-command'
import {
  parseWorkflowCliVersion,
  workflowCliVersionAtLeast,
  WORKFLOW_CLI_MINIMUM_VERSIONS
} from '../../../shared/workflow-cli-version'
import { runProcess } from '../../../shared/child-process/run-process'
import { workflowModelMinimumCliVersion } from './local-workflow-models'

type Route = LocalWorkflowRoute

/** The signed-in Grok account home (the CLI's own default). */
export function grokHome(): string {
  return process.env.GROK_HOME ?? join(homedir(), '.grok')
}

/**
 * The program a launch runs. Streamed Grok runs its real binary: the `grok` on PATH may be a
 * wrapper that strips GROK_HOME and every GROK_* switch the workflow depends on.
 */
export function workflowProgram(route: Route, stream: boolean): string {
  if (route === 'openrouter' || route === 'ollama') {
    return process.execPath
  }
  if (route !== 'grok' || !stream) {
    return route
  }
  try {
    return realpathSync(join(grokHome(), 'bin', 'grok'))
  } catch {
    throw new Error('Grok CLI is not installed.')
  }
}

/** The CLI answered, but with a version older than the measured minimum (or none at all). */
export class WorkflowCliVersionError extends Error {}

export async function assertBinaryVersion(
  route: Route,
  signal?: AbortSignal,
  program: string = route,
  /** A frozen seat's model; some need a newer CLI than their route. */
  model?: string
): Promise<void> {
  if (route === 'openrouter' || route === 'ollama') {
    return
  }
  const minimum = WORKFLOW_CLI_MINIMUM_VERSIONS[route]
  const result = await runProcess({
    program,
    args: ['--version'],
    timeoutMs: 8_000,
    maxOutputBytes: 4_096,
    ...(signal ? { signal } : {})
  })
  const version =
    result.code === 0 && !result.stdoutTruncated && !result.stderrTruncated
      ? parseWorkflowCliVersion(result.stdout)
      : undefined
  if (!version || !workflowCliVersionAtLeast(version, minimum)) {
    throw new WorkflowCliVersionError(
      `${localWorkflowProviderLabel(route)} CLI ${minimum} or newer is required for workflows.`
    )
  }
  const modelMinimum = workflowModelMinimumCliVersion(route, model)
  if (!workflowCliVersionAtLeast(version, modelMinimum)) {
    throw new WorkflowCliVersionError(
      `${localWorkflowProviderLabel(route)} CLI ${modelMinimum} or newer is required for ${model}; this computer has ${version}.`
    )
  }
}

/** Legacy frozen calls run the `grok` on PATH; its MCP servers and skills must be discoverable. */
export async function inspectLegacyGrok(env: NodeJS.ProcessEnv): Promise<void> {
  const cwd = join(getAppEnvironment().getPath('userData'), 'local-workflow-inspect')
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  const inspection = await runProcess({
    program: 'grok',
    args: ['inspect', '--json'],
    cwd,
    env,
    timeoutMs: 15_000,
    maxOutputBytes: 128 * 1024
  })
  if (inspection.code !== 0 || inspection.stdoutTruncated || inspection.stderrTruncated) {
    throw new Error('Grok could not read its account settings. Run grok inspect to check them.')
  }
  const config = JSON.parse(inspection.stdout) as {
    mcpServers?: { name: string }[]
    skills?: { name: string }[]
  }
  buildWorkflowGrokProjectConfig(
    (config.mcpServers ?? []).map((entry) => entry.name),
    (config.skills ?? []).map((entry) => entry.name)
  )
}
