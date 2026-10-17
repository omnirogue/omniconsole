import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import {
  buildWorkflowGrokArgs,
  buildWorkflowGrokHomeConfig,
  buildWorkflowGrokProjectConfig,
  buildWorkflowGrokSandboxConfig,
  buildWorkflowGrokStreamArgs,
  workflowGrokStreamProfile,
  WORKFLOW_GROK_AGENT_PROFILE
} from '../../../shared/workflow-grok-command'
import { runProcess } from '../../../shared/child-process/run-process'
import type { WorkflowAttemptLaunch } from './workflow-durable-call'
import { grokHome, workflowProgram } from './local-workflow-cli-programs'
import { workflowCliModel } from './local-workflow-models'
import type { WorkflowLaunchCommand, WorkflowLaunchMode } from './local-workflow-provider-commands'
import { workflowGrokDeniedPaths } from './local-workflow-read-scope'

type LaunchInput = Parameters<WorkflowAttemptLaunch>[0]

async function inspectGrok(
  program: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<{ mcpServers?: { name: string }[]; skills?: { name: string }[] }> {
  const inspection = await runProcess({
    program,
    args: ['inspect', '--json'],
    cwd,
    env,
    timeoutMs: 15_000,
    maxOutputBytes: 512 * 1024,
    signal
  })
  if (inspection.code !== 0 || inspection.stdoutTruncated || inspection.stderrTruncated) {
    throw new Error('Grok could not read its account settings. Run grok inspect to check them.')
  }
  return JSON.parse(inspection.stdout)
}

/** The frozen-evidence argv from before streamed launches, byte for byte. */
export async function legacyGrokCommand(
  seat: ResolvedLocalWorkflowSeat,
  input: LaunchInput,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string
): Promise<WorkflowLaunchCommand> {
  const config = await inspectGrok('grok', cwd, env, input.signal)
  const project = join(cwd, '.grok')
  await mkdir(project, { mode: 0o700 })
  await writeFile(
    join(project, 'config.toml'),
    buildWorkflowGrokProjectConfig(
      (config.mcpServers ?? []).map((entry) => entry.name),
      (config.skills ?? []).map((entry) => entry.name)
    ),
    { mode: 0o600 }
  )
  const profilePath = join(cwd, 'workflow-agent.md')
  const promptPath = join(cwd, 'prompt.txt')
  await writeFile(profilePath, WORKFLOW_GROK_AGENT_PROFILE, { mode: 0o600 })
  await writeFile(promptPath, prompt, { mode: 0o600 })
  return {
    program: 'grok',
    args: buildWorkflowGrokArgs({
      model: workflowCliModel('grok', seat.model),
      effort: seat.effort ?? undefined,
      attemptId: input.attemptId,
      schema: input.call.schema,
      profilePath,
      promptPath
    }),
    cwd,
    env
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** The latest `expires_at` among a Grok auth.json's logins; undefined when there is none. */
export function workflowGrokAuthExpiry(text: string): number | undefined {
  try {
    const logins = Object.values(JSON.parse(text) as Record<string, { expires_at?: unknown }>)
    const times = logins
      .map((login) =>
        typeof login?.expires_at === 'string' ? Date.parse(login.expires_at) : Number.NaN
      )
      .filter(Number.isFinite)
    return times.length ? Math.max(...times) : undefined
  } catch {
    return undefined
  }
}

async function accountAuthExpiry(account: string): Promise<number | undefined> {
  const text = await readFile(join(account, 'auth.json'), 'utf8').catch(() => undefined)
  return text === undefined ? undefined : workflowGrokAuthExpiry(text)
}

/**
 * Whether a run of `withinMs` could outlive the account's Grok login. Parallel runs would each
 * refresh it in their own private home, so such launches queue on the account instead.
 */
export async function workflowGrokLoginExpiresWithin(
  account: string,
  withinMs: number
): Promise<boolean> {
  const expiry = await accountAuthExpiry(account)
  return expiry !== undefined && expiry - Date.now() < withinMs
}

/**
 * A token refresh replaces the private home's auth.json link with a file. Copy it back so the
 * account keeps the rotated login, unless the account already holds a login that lasts as long.
 * Expiry, not file time, decides: a copy is stamped when copied, not when refreshed. Either way the
 * private copy is then deleted: attempt folders are kept, and a live login must not pile up there.
 */
export async function carryBackWorkflowGrokAuth(home: string, account: string): Promise<void> {
  const refreshed = join(home, 'auth.json')
  try {
    if (!(await lstat(refreshed)).isFile()) {
      return
    }
  } catch {
    return
  }
  // Unique per carry-back: the cleanup below must never remove another attempt's stage.
  const staged = join(account, `.auth.json.workflow-${process.pid}-${randomUUID()}`)
  try {
    const next = workflowGrokAuthExpiry(await readFile(refreshed, 'utf8'))
    const current = await accountAuthExpiry(account)
    if (next === undefined || (current !== undefined && current >= next)) {
      return
    }
    await copyFile(refreshed, staged)
    await chmod(staged, 0o600)
    await rename(staged, join(account, 'auth.json'))
  } catch {
    // The account keeps its previous token; the next session refreshes it again.
  } finally {
    // A renamed stage is already gone; a failed one must not linger in the account either.
    await Promise.all([refreshed, staged].map((path) => rm(path, { force: true }).catch(() => {})))
  }
}

/**
 * Streamed Grok: the real binary with a private GROK_HOME under the attempt folder (account
 * config minus MCP servers and skills, auth linked). Nothing is written into the workspace.
 */
export async function streamGrokCommand(
  seat: ResolvedLocalWorkflowSeat,
  input: LaunchInput,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  mode: WorkflowLaunchMode
): Promise<WorkflowLaunchCommand> {
  const program = workflowProgram('grok', true)
  const account = await realpath(grokHome())
  const home = join(cwd, 'grok-home')
  await mkdir(home, { mode: 0o700 })
  await symlink(join(account, 'auth.json'), join(home, 'auth.json'))
  // Mandatory policy layers still apply inside the private home.
  for (const name of ['managed_config.toml', 'requirements.toml']) {
    if (await exists(join(account, name))) {
      await symlink(join(account, name), join(home, name))
    }
  }
  const accountConfig = await readFile(join(account, 'config.toml'), 'utf8').catch(() => '')
  const configPath = join(home, 'config.toml')
  await writeFile(configPath, buildWorkflowGrokHomeConfig(accountConfig), { mode: 0o600 })
  const privateEnv = { ...env, GROK_HOME: home }
  const config = await inspectGrok(program, cwd, privateEnv, input.signal)
  await writeFile(
    configPath,
    buildWorkflowGrokHomeConfig(
      accountConfig,
      (config.skills ?? []).map((entry) => entry.name)
    ),
    { mode: 0o600 }
  )
  let workdir = mode.root
  if (!workdir) {
    workdir = join(cwd, 'empty')
    await mkdir(workdir, { mode: 0o700 })
  }
  // Written after inspect, which may seed a default sandbox.toml in a fresh home.
  const attempt = await realpath(cwd)
  await writeFile(
    join(home, 'sandbox.toml'),
    buildWorkflowGrokSandboxConfig({
      readOnly: [account, attempt],
      readWrite: [join(attempt, 'grok-home')],
      deny: await workflowGrokDeniedPaths({ account, needed: [attempt], root: mode.root })
    }),
    { mode: 0o600 }
  )
  const profilePath = join(cwd, 'workflow-agent.md')
  const promptPath = join(cwd, 'prompt.txt')
  await writeFile(profilePath, workflowGrokStreamProfile(mode.access, mode.output), { mode: 0o600 })
  await writeFile(promptPath, prompt, { mode: 0o600 })
  return {
    program,
    args: buildWorkflowGrokStreamArgs({
      model: workflowCliModel('grok', seat.model),
      effort: seat.effort ?? undefined,
      attemptId: input.attemptId,
      profilePath,
      promptPath,
      cwd: workdir,
      access: mode.access,
      ...(mode.output === 'schema' ? { schema: input.call.schema } : {})
    }),
    cwd,
    env: privateEnv,
    settle: () => carryBackWorkflowGrokAuth(home, account)
  }
}
