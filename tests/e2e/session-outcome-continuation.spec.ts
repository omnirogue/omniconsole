import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { RuntimeClientError } from '../../src/cli/runtime/types'
import type { SessionChain } from '../../src/shared/session-chain-types'
import type { SessionOutcomeDefinition } from '../../src/shared/session-outcome-types'
import type { RuntimeMetadata } from '../../src/shared/runtime-bootstrap'
import type { RuntimeStatus, RuntimeTerminalCreate } from '../../src/shared/runtime-types'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import {
  cleanupE2EDaemons,
  cleanupE2EProfileRuntime,
  closeElectronAppForE2E
} from './helpers/electron-process-shutdown'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { expect, forwardElectronProcessLogs, test } from './helpers/orca-app'
import {
  cleanupDeterministicOutcomeAgent,
  clearDeterministicOutcomeAgentLedger,
  deterministicOutcomeAgentCommand,
  deterministicOutcomeAgentEnv,
  encodedOutcomeInstruction,
  readDeterministicOutcomeAgentLedger
} from './helpers/session-outcome-deterministic-agent'

/**
 * Resolved when a test launches Electron, never at import time. A spec that reads the packaged
 * runtime at module scope cannot even be LISTED in a job that has not installed it, and
 * Playwright loads every spec before sharding, so one such read breaks the whole suite.
 */
function electronExecutablePath(): string {
  const electronPackageDir = path.join(process.cwd(), 'node_modules', 'electron')
  return path.join(
    electronPackageDir,
    'dist',
    readFileSync(path.join(electronPackageDir, 'path.txt'), 'utf8').trim()
  )
}
const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')

type OutcomeProgress = {
  chain: SessionChain
  lifecycle: 'waiting' | 'needs-you' | 'complete'
  phase: 'active' | 'recovering' | 'waiting' | 'needs-you' | 'failed' | 'completed'
  satisfied: number
  total: number
}

function createWorkspace(): string {
  const workspace = mkdtempSync(path.join('/tmp', 'oc-work-'))
  execFileSync('git', ['init', workspace])
  writeFileSync(path.join(workspace, 'README.md'), 'Disposable continuation fixture.\n')
  execFileSync('git', ['-C', workspace, 'add', 'README.md'])
  execFileSync('git', [
    '-C',
    workspace,
    '-c',
    'user.name=Orca E2E',
    '-c',
    'user.email=orca-e2e@example.invalid',
    'commit',
    '-m',
    'Initialize deterministic fixture'
  ])
  return workspace
}

function createProfile(prefix: string): string {
  // Darwin's sockaddr_un path is short; the GUI LaunchAgent temp root is too long.
  return mkdtempSync(path.join('/tmp', prefix))
}

async function waitForRuntime(client: RuntimeClient): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await client.call('status.get')
          return true
        } catch (error) {
          if (error instanceof RuntimeClientError && error.code === 'runtime_unavailable') {
            return false
          }
          throw error
        }
      },
      { timeout: 60_000, message: 'isolated runtime metadata was not published' }
    )
    .toBe(true)
}

function launchEnvironment(userDataDir: string): Record<string, string> {
  const { ELECTRON_RUN_AS_NODE: _unused, ...clean } = process.env
  void _unused
  const env = createElectronHomeIsolation({
    inheritedEnv: clean,
    launchEnv: {
      ...deterministicOutcomeAgentEnv(),
      NODE_ENV: 'development',
      ORCA_E2E_HEADLESS: '1',
      ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1'
    },
    extraEnv: {},
    userDataDir
  }).env
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function definition(
  id: string,
  outputPath: string,
  contents: string,
  gatePath?: string
): SessionOutcomeDefinition {
  return {
    id,
    title: `Produce ${id}`,
    finish: 'complete',
    dependsOn: [],
    conditions: [{ id: `${id}_file`, kind: 'file', target: outputPath }],
    actions: [
      {
        id: `${id}_write`,
        instruction: encodedOutcomeInstruction({ outcomeId: id, outputPath, contents, gatePath }),
        conditionIds: [`${id}_file`],
        authority: 'existing-user-authority',
        agent: 'codex'
      }
    ]
  }
}

async function rendererRpc<T>(page: Page, method: string, params?: unknown): Promise<T> {
  return (await page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  )) as T
}

async function configureAgent(page: Page): Promise<void> {
  await page.evaluate(async (command) => {
    await window.api.settings.set({
      defaultTuiAgent: 'codex',
      agentCmdOverrides: { codex: command }
    })
  }, deterministicOutcomeAgentCommand)
}

async function sourceChain(
  client: RuntimeClient,
  workspace: string,
  id: string
): Promise<SessionChain> {
  const added = await client.call<{ repo: { id: string } }>('repo.add', {
    path: workspace,
    kind: 'git'
  })
  let worktreeId = ''
  let worktreePath = ''
  await expect
    .poll(async () => {
      const listed = await client.call<{ worktrees: { id: string; path: string }[] }>(
        'worktree.detectedList',
        {
          repo: `id:${added.result.repo.id}`
        }
      )
      worktreeId = listed.result.worktrees[0]?.id ?? ''
      worktreePath = listed.result.worktrees[0]?.path ?? ''
      return worktreeId
    })
    .not.toBe('')
  const created = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
    worktree: `id:${worktreeId}`,
    title: 'Outcome source',
    command: 'printf outcome-source-finished; exit'
  })
  const terminal = created.result.terminal
  if (!terminal.paneKey) {
    throw new Error('Source terminal has no durable pane key')
  }
  await client.call('terminal.wait', {
    terminal: terminal.handle,
    for: 'exit',
    timeoutMs: 30_000
  })
  const now = Date.now()
  return {
    id,
    workspacePath: worktreePath,
    worktreeId: terminal.worktreeId,
    hostId: 'local',
    sourcePaneKey: terminal.paneKey,
    sourceRowKey: terminal.paneKey,
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: now,
    updatedAt: now
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 30_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`PID ${child.pid} did not exit`)), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

function metadata(userDataDir: string): RuntimeMetadata {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'omni-runtime.json'), 'utf8')
  ) as RuntimeMetadata
}

async function launchDesktop(
  userDataDir: string,
  env: Record<string, string>
): Promise<ElectronApplication> {
  writeFileSync(
    path.join(userDataDir, 'omni-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )
  return await electron.launch({ args: getOrcaElectronLaunchArgs(mainPath, false), env })
}

test.describe.configure({ mode: 'serial' })

test.afterAll(() => cleanupDeterministicOutcomeAgent())

test('continues real file outcomes in the replacement headless owner and promotes it', async (// oxlint-disable-next-line no-empty-pattern -- This test owns multiple native processes.
{}, testInfo) => {
  test.setTimeout(240_000)
  clearDeterministicOutcomeAgentLedger()
  const userDataDir = createProfile('oc-cont-')
  const workspace = createWorkspace()
  const env = launchEnvironment(userDataDir)
  const firstPath = path.join(workspace, 'first.txt')
  const secondPath = path.join(workspace, 'second.txt')
  const secondGate = path.join(workspace, '.release-second')
  let app: ElectronApplication | null = null
  let activator: ChildProcess | null = null
  try {
    app = await launchDesktop(userDataDir, env)
    forwardElectronProcessLogs(app, testInfo)
    const page = await app.firstWindow({ timeout: 60_000 })
    await configureAgent(page)
    const client = new RuntimeClient(userDataDir, 30_000)
    await waitForRuntime(client)
    const chain = await sourceChain(client, workspace, 'chain_native_continuation')
    await expect
      .poll(
        async () =>
          (
            await rendererRpc<{ durableContinuation: boolean }>(
              page,
              'sessionChain.outcomeCapabilities'
            )
          ).durableContinuation
      )
      .toBe(true)
    await rendererRpc(page, 'sessionChain.commitOutcomes', {
      chain,
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        definition('first', firstPath, 'first-result'),
        definition('second', secondPath, 'second-result', secondGate)
      ]
    })
    await expect
      .poll(
        async () => {
          const progress = (
            await client.call<OutcomeProgress>('sessionChain.outcomeProgress', { id: chain.id })
          ).result
          // Fail fast instead of timing out: a stopped run reads as failed now, and only a
          // genuine request of the owner as needs-you. Neither can produce the file.
          if (progress.phase === 'failed' || progress.phase === 'needs-you') {
            throw new Error(
              `Outcome blocked: ${JSON.stringify({ progress, agent: readDeterministicOutcomeAgentLedger() })}`
            )
          }
          return existsSync(firstPath)
        },
        { timeout: 60_000 }
      )
      .toBe(true)
    await expect
      .poll(
        () => {
          const ledger = readDeterministicOutcomeAgentLedger()
          const failedReport = ledger.find(
            (event) => event.event === 'reported' && event.status !== 0
          )
          if (failedReport) {
            throw new Error(`worker_done failed: ${JSON.stringify(failedReport)}`)
          }
          return ledger.filter(
            (event) => event.event === 'accepted' && event.outcomeId === 'second'
          ).length
        },
        { timeout: 60_000 }
      )
      .toBe(1)
    // Why a poll: the first worker writes its file BEFORE it reports worker_done, and only that
    // completed attempt plus the file's receipt satisfy the outcome, so one read races the tick.
    let before!: OutcomeProgress
    await expect
      .poll(
        async () => {
          before = (
            await client.call<OutcomeProgress>('sessionChain.outcomeProgress', { id: chain.id })
          ).result
          return { lifecycle: before.lifecycle, satisfied: before.satisfied, total: before.total }
        },
        { timeout: 60_000 }
      )
      .toEqual({ lifecycle: 'waiting', satisfied: 1, total: 2 })
    const firstAttempt = before.chain.outcomeSet!.attempts.find(
      (attempt) => attempt.outcomeId === 'first'
    )!
    const firstReceipt = before.chain.outcomeSet!.outcomes[0]!.evidence[0]!
    const oldPid = app.process().pid
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await waitForExit(app.process())
    await expect
      .poll(
        () => {
          const metadataPath = path.join(userDataDir, 'omni-runtime.json')
          return existsSync(metadataPath) ? metadata(userDataDir).pid : oldPid
        },
        {
          timeout: 60_000,
          message: 'replacement --serve owner did not acquire the same profile'
        }
      )
      .not.toBe(oldPid)
    const headlessPid = metadata(userDataDir).pid
    await expect
      .poll(async () => (await client.call<RuntimeStatus>('status.get')).result.desktopWindowStatus)
      .toBe('openable')
    writeFileSync(secondGate, 'release')
    await expect.poll(() => existsSync(secondPath), { timeout: 60_000 }).toBe(true)
    await expect
      .poll(
        async () =>
          (await client.call<OutcomeProgress>('sessionChain.outcomeProgress', { id: chain.id }))
            .result.lifecycle,
        {
          timeout: 60_000
        }
      )
      .toBe('complete')
    const completed = (
      await client.call<OutcomeProgress>('sessionChain.outcomeProgress', { id: chain.id })
    ).result.chain
    expect(completed.outcomeSet!.attempts.find((attempt) => attempt.outcomeId === 'first')).toEqual(
      firstAttempt
    )
    expect(completed.outcomeSet!.outcomes[0]!.evidence[0]).toEqual(firstReceipt)
    expect(
      readDeterministicOutcomeAgentLedger().filter(
        (event) => event.event === 'accepted' && event.outcomeId === 'first'
      )
    ).toHaveLength(1)
    activator = spawn(electronExecutablePath(), getOrcaElectronLaunchArgs(mainPath, false), {
      env,
      stdio: 'ignore'
    })
    await expect
      .poll(
        async () => (await client.call<RuntimeStatus>('status.get')).result.desktopWindowStatus,
        {
          timeout: 60_000
        }
      )
      .toBe('available')
    expect(metadata(userDataDir).pid).toBe(headlessPid)
    expect(
      (await client.call<OutcomeProgress>('sessionChain.outcomeProgress', { id: chain.id })).result
        .lifecycle
    ).toBe('complete')
    await waitForExit(activator)
  } finally {
    if (activator && activator.exitCode === null) {
      activator.kill('SIGKILL')
    }
    try {
      if (app && app.process().exitCode === null) {
        await closeElectronAppForE2E(app)
      }
    } catch {
      // Playwright may already have disposed the exited launcher's process channel.
    }
    // Detached runtime/PTY processes can keep the exited launcher's stdio open on Linux.
    // Stop this disposable profile before Playwright waits for the child process to close.
    await cleanupE2EProfileRuntime(userDataDir)
    await cleanupE2EDaemons(userDataDir)
    if (app) {
      await closeElectronAppForE2E(app)
    }
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('adding an obligation to a completed set launches only the new action', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its isolated native app.
{}, testInfo) => {
  test.setTimeout(180_000)
  clearDeterministicOutcomeAgentLedger()
  const userDataDir = createProfile('oc-edit-')
  const workspace = createWorkspace()
  const env = launchEnvironment(userDataDir)
  let app: ElectronApplication | null = null
  try {
    app = await launchDesktop(userDataDir, env)
    forwardElectronProcessLogs(app, testInfo)
    const page = await app.firstWindow({ timeout: 60_000 })
    await configureAgent(page)
    const client = new RuntimeClient(userDataDir, 30_000)
    await waitForRuntime(client)
    const chain = await sourceChain(client, workspace, 'chain_native_edit')
    const first = definition('existing', path.join(workspace, 'existing.txt'), 'existing')
    const added = definition('added', path.join(workspace, 'added.txt'), 'added')
    const committed = await rendererRpc<{ chain: SessionChain }>(
      page,
      'sessionChain.commitOutcomes',
      { chain, expectedRevision: 0, source: 'user', outcomes: [first] }
    )
    await expect
      .poll(
        async () =>
          (await client.call<OutcomeProgress>('sessionChain.outcomeProgress', { id: chain.id }))
            .result.lifecycle,
        {
          timeout: 60_000
        }
      )
      .toBe('complete')
    const stable = (
      await client.call<OutcomeProgress>('sessionChain.outcomeProgress', { id: chain.id })
    ).result.chain.outcomeSet!
    // A completed run is sealed: new work is a new run, and the proven one is not run again.
    const forked = await rendererRpc<{ chain: SessionChain }>(page, 'sessionChain.commitOutcomes', {
      chain: committed.chain,
      expectedRevision: stable.revision,
      source: 'user',
      outcomes: [first, added]
    })
    expect(forked.chain.id).not.toBe(chain.id)
    await expect
      .poll(
        async () =>
          (
            await client.call<OutcomeProgress>('sessionChain.outcomeProgress', {
              id: forked.chain.id
            })
          ).result.lifecycle,
        {
          timeout: 60_000
        }
      )
      .toBe('complete')
    const next = (
      await client.call<OutcomeProgress>('sessionChain.outcomeProgress', { id: forked.chain.id })
    ).result.chain.outcomeSet!
    expect(next.outcomes.map((outcome) => outcome.id)).toEqual(['added'])
    const after = (
      await client.call<OutcomeProgress>('sessionChain.outcomeProgress', { id: chain.id })
    ).result.chain.outcomeSet!
    expect(after.outcomes).toHaveLength(1)
    expect(after.completion).toBeDefined()
    expect(after.outcomes[0]!.evidence).toEqual(stable.outcomes[0]!.evidence)
    expect(after.attempts.filter((attempt) => attempt.outcomeId === 'existing')).toEqual(
      stable.attempts.filter((attempt) => attempt.outcomeId === 'existing')
    )
    expect(
      readDeterministicOutcomeAgentLedger().filter((event) => event.event === 'accepted')
    ).toHaveLength(2)
  } finally {
    if (app) {
      await closeElectronAppForE2E(app)
    }
    await cleanupE2EProfileRuntime(userDataDir)
    await cleanupE2EDaemons(userDataDir)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})
