import { readFileSync } from 'node:fs'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { LocalRunSnapshot } from '../../src/shared/local-run-types'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-terminal-contracts'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { FAKE_AGENT_WINDOWS_SHELL } from './helpers/fake-agent-command-override'
import {
  cleanupLocalRunAgent,
  localRunAgentCommand,
  localRunAgentEnv,
  localRunAgentGate,
  localRunAgentInstruction,
  readLocalRunAgentLedger,
  releaseLocalRunAgent
} from './helpers/local-run-deterministic-agent'

test.use({ launchEnv: localRunAgentEnv })
test.afterAll(cleanupLocalRunAgent)

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('Run locally starts two processes together and joins their retained reports exactly once', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  testInfo.annotations.push({
    type: 'evidence-scope',
    description:
      'Real UI graph launch, Electron, PTYs, task DAG, authenticated worker_done and files; deterministic agents, no external provider or BFF.'
  })
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000)
  let workspace = ''
  await expect
    .poll(async () => {
      const listed = await client.call<{ worktrees: { id: string; path: string }[] }>(
        'worktree.list'
      )
      workspace = listed.result.worktrees.find((entry) => entry.id === worktreeId)?.path ?? ''
      return workspace
    })
    .not.toBe('')
  await orcaPage.evaluate(
    async ({ command, windowsShell }) => {
      const state = window.__store!.getState()
      await state.updateSettings({
        agentCmdOverrides: { codex: command },
        terminalWindowsShell: windowsShell
      })
      state.openLocalRunsPage()
    },
    { command: localRunAgentCommand, windowsShell: FAKE_AGENT_WINDOWS_SHELL }
  )
  await orcaPage.getByRole('button', { name: 'New graph', exact: true }).click()
  await orcaPage.getByRole('combobox', { name: 'Workspace', exact: true }).click()
  await orcaPage.getByRole('option').filter({ hasText: workspace }).click()
  await orcaPage
    .getByRole('textbox', { name: 'Graph name', exact: true })
    .fill('Two workers and one join')
  await orcaPage.getByRole('combobox', { name: 'Start from a template', exact: true }).click()
  await orcaPage.getByRole('option', { name: 'Fan-out → Synthesize', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'How many', exact: true }).fill('2')
  await orcaPage.getByRole('button', { name: 'Use this template', exact: true }).click()
  const branches = [
    { nodeId: 'branch-1', token: 'FIRST-REPORT-8f279b' },
    { nodeId: 'branch-2', token: 'SECOND-REPORT-13cd95' }
  ]
  for (const branch of branches) {
    const editor = orcaPage.getByRole('group', { name: branch.nodeId, exact: true })
    await editor.getByRole('combobox', { name: 'Action', exact: true }).click()
    await orcaPage.getByRole('option', { name: 'Research', exact: true }).click()
    await editor
      .getByRole('textbox', { name: 'Objective', exact: true })
      .fill(localRunAgentInstruction({ ...branch, gatePath: localRunAgentGate(branch.nodeId) }))
  }
  const joinEditor = orcaPage.getByRole('group', { name: 'synthesize', exact: true })
  await joinEditor.getByRole('textbox', { name: 'Objective', exact: true }).fill(
    localRunAgentInstruction({
      nodeId: 'synthesize',
      token: 'JOIN-VERIFIED',
      predecessors: branches
    })
  )
  for (const branch of branches) {
    await expect(
      joinEditor.getByRole('checkbox', { name: branch.nodeId, exact: true })
    ).toBeChecked()
  }
  const graph = orcaPage.getByRole('region', { name: 'Graph', exact: true })
  const node = (id: string) =>
    graph.getByRole('button').filter({
      has: orcaPage.getByText(id, { exact: true })
    })
  let runId: string | null = null
  const status = async () =>
    (await client.call<{ run: LocalRunSnapshot }>('localRun.status', { id: runId })).result.run
  try {
    await orcaPage.getByRole('button', { name: 'Run locally', exact: true }).click()
    await expect
      .poll(
        async () => {
          const listed = await client.call<{ runs: LocalRunSnapshot[] }>('localRun.list')
          runId = listed.result.runs.find((run) => run.workspacePath === workspace)?.id ?? null
          return runId
        },
        { timeout: 30_000 }
      )
      .not.toBeNull()
    await expect
      .poll(() => readLocalRunAgentLedger().filter((event) => event.event === 'accepted'), {
        timeout: 60_000
      })
      .toHaveLength(2)
    await expect(node('branch-1')).toContainText('Running', { timeout: 30_000 })
    await expect(node('branch-2')).toContainText('Running')
    await expect(node('synthesize')).toContainText('Queued')
    const accepted = readLocalRunAgentLedger().filter((event) => event.event === 'accepted')
    expect(new Set(accepted.map((event) => event.pid)).size).toBe(2)
    expect(new Set(accepted.map((event) => event.dispatchId)).size).toBe(2)
    // A task becomes Running before workerStart returns its dispatch receipt.
    // Wait for publication, then require the exact capability-backed identity
    // observed inside each real worker process; UI status alone is insufficient.
    await expect
      .poll(
        async () => {
          const snapshot = await status()
          return branches.map((branch) => {
            const actual = snapshot.nodes.find((entry) => entry.id === branch.nodeId)
            return {
              nodeId: actual?.id,
              taskId: actual?.taskId,
              dispatchId: actual?.dispatchId,
              terminalHandle: actual?.terminalHandle
            }
          })
        },
        { timeout: 30_000 }
      )
      .toEqual(
        branches.map((branch) => {
          const event = accepted.find((entry) => entry.nodeId === branch.nodeId)!
          return {
            nodeId: event.nodeId,
            taskId: event.taskId,
            dispatchId: event.dispatchId,
            terminalHandle: event.terminalHandle
          }
        })
      )
    const concurrent = await status()
    expect(concurrent.maxConcurrent).toBe(2)
    const terminals = (await client.call<RuntimeTerminalListResult>('terminal.list')).result
      .terminals
    for (const branch of branches) {
      const event = accepted.find((entry) => entry.nodeId === branch.nodeId)!
      const actual = concurrent.nodes.find((entry) => entry.id === branch.nodeId)!
      expect(event).toMatchObject({ taskId: actual.taskId, dispatchId: actual.dispatchId })
      expect(actual.terminalHandle).toBe(event.terminalHandle)
      expect(terminals.find((terminal) => terminal.handle === actual.terminalHandle)).toMatchObject(
        { connected: true }
      )
      expect(alive(event.pid)).toBe(true)
    }
    expect(concurrent.nodes.find((entry) => entry.id === 'synthesize')?.dispatchId).toBeNull()
    await orcaPage.screenshot({ path: testInfo.outputPath('two-workers-running.png') })

    releaseLocalRunAgent('branch-1')
    await expect
      .poll(
        () =>
          readLocalRunAgentLedger().find(
            (event) => event.event === 'reported' && event.nodeId === 'branch-1'
          ),
        { timeout: 30_000 }
      )
      .toMatchObject({ status: 0 })
    await expect(node('branch-1')).toContainText('Completed', { timeout: 30_000 })
    await expect(node('branch-2')).toContainText('Running')
    await expect(node('synthesize')).toContainText('Queued')
    // A sustained hold catches a join admitted on the first receipt alone.
    await orcaPage.waitForTimeout(3_000)
    expect(readLocalRunAgentLedger().filter((event) => event.event === 'accepted')).toHaveLength(2)
    expect((await status()).nodes.find((entry) => entry.id === 'synthesize')?.dispatchId).toBeNull()
    expect(alive(accepted.find((entry) => entry.nodeId === 'branch-2')!.pid)).toBe(true)

    releaseLocalRunAgent('branch-2')
    await expect.poll(async () => (await status()).stage, { timeout: 60_000 }).toBe('completed')
    for (const id of ['branch-1', 'branch-2', 'synthesize']) {
      await expect(node(id)).toContainText('Completed')
    }
    const final = await status()
    const ledger = readLocalRunAgentLedger()
    expect(ledger.filter((event) => event.event === 'error')).toEqual([])
    expect(ledger.filter((event) => event.event === 'spawn')).toHaveLength(3)
    const executions = ledger.filter((event) => event.event === 'accepted')
    expect(executions).toHaveLength(3)
    expect(new Set(executions.map((event) => event.nodeId)).size).toBe(3)
    expect(new Set(executions.map((event) => event.dispatchId)).size).toBe(3)
    expect(ledger.filter((event) => event.event === 'reported')).toMatchObject([
      { nodeId: 'branch-1', status: 0 },
      { nodeId: 'branch-2', status: 0 },
      { nodeId: 'synthesize', status: 0 }
    ])
    const consumed = ledger.filter((event) => event.event === 'consumed')
    expect(consumed).toHaveLength(1)
    expect(consumed[0]).toMatchObject({
      nodeId: 'synthesize',
      consumed: branches.map((branch) => ({
        nodeId: branch.nodeId,
        contents: `${branch.token}\n`
      }))
    })
    for (const branch of branches) {
      const written = ledger.find(
        (event) => event.event === 'wrote' && event.nodeId === branch.nodeId
      )!
      expect(consumed[0].consumed!.find((entry) => entry.nodeId === branch.nodeId)?.path).toBe(
        written.outputPath
      )
      expect(readFileSync(written.reportPath!, 'utf8')).toContain(
        `LOCAL_RUN_REPORT ${branch.nodeId} ${branch.token}`
      )
    }
    const joined = final.nodes.find((entry) => entry.id === 'synthesize')!
    const result = joined.producedFiles.find((file) => file.endsWith('synthesize.txt'))!
    expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual(consumed[0].consumed)
    await node('synthesize').click()
    await expect(orcaPage.getByText(result, { exact: true })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Stop this run', exact: true })).toHaveCount(
      0
    )
    await orcaPage.screenshot({ path: testInfo.outputPath('parallel-join-completed.png') })
    await testInfo.attach('execution-receipts', {
      body: JSON.stringify({ run: final, ledger }, null, 2),
      contentType: 'application/json'
    })
  } finally {
    await testInfo.attach('local-run-agent-events', {
      body: JSON.stringify(readLocalRunAgentLedger(), null, 2),
      contentType: 'application/json'
    })
    if (runId) {
      const current = await status().catch(() => null)
      await testInfo.attach('local-run-final-snapshot', {
        body: JSON.stringify(current, null, 2),
        contentType: 'application/json'
      })
      if (current && ['created', 'starting', 'running'].includes(current.stage)) {
        await client.call('localRun.cancel', { id: runId })
      }
    }
  }
})
