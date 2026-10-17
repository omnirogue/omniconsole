import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { configureGoldenStubAgent, getGoldenStubAgentLaunchEnv } from './helpers/golden-stub-agent'
import { cleanupE2EProfileCrashpad } from './helpers/electron-crashpad-cleanup'
import {
  captureElectronLaunchDescendants,
  cleanupElectronLaunchDescendants
} from './helpers/electron-launch-descendant-cleanup'
import {
  cleanupE2EProfileRuntime,
  closeElectronAppForE2E
} from './helpers/electron-process-shutdown'
import { waitForActivePaneHookDescriptor, waitForTerminalOutput } from './helpers/terminal'

const scratch = path.join(os.tmpdir(), `orca-work-decision-${randomUUID()}`)
const controlPath = path.join(scratch, 'question.json')
const receiptPath = path.join(scratch, 'received.jsonl')

test.use({
  launchEnv: {
    ...getGoldenStubAgentLaunchEnv(),
    GOLDEN_STUB_AGENT_TITLE: 'claude',
    GOLDEN_STUB_QUESTION_CONTROL: controlPath
  }
})
test.beforeAll(() => mkdirSync(scratch, { recursive: true }))
test.afterAll(() => rmSync(scratch, { recursive: true, force: true }))
test.afterEach(async ({ electronApp, registerPostElectronShutdownCleanup }) => {
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const proc = electronApp.process()
  const executable = proc.spawnfile
  const errors: unknown[] = []
  const steps = [
    async () => {
      const snapshot = captureElectronLaunchDescendants(proc)
      registerPostElectronShutdownCleanup(async () => {
        const receipt = await cleanupElectronLaunchDescendants(proc, snapshot)
        console.log(
          '[e2e:final-launch-cleanup-v1]',
          JSON.stringify({ phase: 'after-fixture-cleanup', snapshot, receipt })
        )
      })
    },
    async () => await closeElectronAppForE2E(electronApp),
    async () => await cleanupE2EProfileRuntime(userDataDir),
    async () => await cleanupE2EProfileCrashpad(userDataDir, executable)
  ]
  // A refused ownership capture must still run the established profile cleanup.
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, 'Native decision fixture cleanup failed')
  }
})

function inputs(): { revision: string; input: string }[] {
  try {
    return readFileSync(receiptPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

test('a click on a local question option on the Work page reaches the terminal', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await configureGoldenStubAgent(orcaPage, { agent: 'claude' })
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.createTab(state.activeWorktreeId!, undefined, undefined, {
      launchAgent: 'claude',
      viewMode: 'terminal',
      pendingStartup: {
        command: 'golden-stub-agent',
        launchAgent: 'claude',
        startupCommandDelivery: 'shell-ready'
      }
    } as never)
    state.setActiveTabType('terminal')
  })
  await waitForTerminalOutput(orcaPage, 'GOLDEN_STUB_AGENT_READY', 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const endpoint = await readHookEndpoint(electronApp)
  const sessionId = randomUUID()
  const arm = (revision: string): void =>
    writeFileSync(
      controlPath,
      JSON.stringify({
        revision,
        screenOnly: false,
        endpoint,
        sessionId,
        receiptPath,
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId
      }),
      { mode: 0o600 }
    )

  const diagnostics = async (name: string): Promise<void> => {
    const state = await orcaPage.evaluate((paneKey) => {
      const s = window.__store!.getState()
      const status = s.agentStatusByPaneKey[paneKey]
      return {
        toasts: [...document.querySelectorAll('[data-sonner-toast]')].map((t) =>
          (t as HTMLElement).innerText.slice(0, 200)
        ),
        status: status
          ? {
              state: status.state,
              agentType: status.agentType,
              interactivePrompt: status.interactivePrompt?.slice(0, 200),
              stateStartedAt: status.stateStartedAt
            }
          : null
      }
    }, descriptor.paneKey)
    await testInfo.attach(name, {
      body: Buffer.from(JSON.stringify({ state, inputs: inputs() }, null, 2)),
      contentType: 'application/json'
    })
    await orcaPage.screenshot({ path: testInfo.outputPath(`${name}.png`) })
  }

  await orcaPage.evaluate(() => window.__store!.getState().openWorkPage())
  arm('needs')
  const decisions = orcaPage.getByRole('region', { name: 'Needs You — Questions' })
  await expect(decisions.getByText(/Paired fixture needs: pick the test marker/)).toBeVisible({
    timeout: 30_000
  })
  await diagnostics('before-decisions-click')
  const readPending = () =>
    orcaPage.evaluate(async () => {
      const response = await window.api.runtime.call({
        method: 'sessionDecisions.list',
        params: {}
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return (
        response.result as {
          decisions: { key: string; paneKey: string; toolUseId: string | null }[]
        }
      ).decisions
    })
  const beforeAnswer = (await readPending()).filter(
    (row) => row.paneKey === descriptor.paneKey && row.toolUseId === 'fixture-needs'
  )
  expect(beforeAnswer).toHaveLength(1)
  const decisionKey = beforeAnswer[0]!.key
  await testInfo.attach('exact-native-key-before-answer', {
    body: Buffer.from(JSON.stringify({ decisionKey, beforeAnswer }, null, 2)),
    contentType: 'application/json'
  })
  await decisions.getByRole('button', { name: /Blue/ }).click()
  try {
    await expect
      .poll(() => inputs(), { timeout: 10_000 })
      .toEqual([{ revision: 'needs', input: '1' }])
    await expect
      .poll(async () => (await readPending()).map((row) => row.key), { timeout: 10_000 })
      .not.toContain(decisionKey)
    await expect(decisions.getByText(/Paired fixture needs: pick the test marker/)).toHaveCount(0)
    await expect(decisions).toHaveAttribute('data-work-decisions', '0')
    // Reopening Work remounts the queue and rules out its optimistic per-mount suppression.
    await orcaPage.evaluate(() => window.__store!.getState().closeWorkPage())
    await expect(decisions).toHaveCount(0)
    await orcaPage.evaluate(() => window.__store!.getState().openWorkPage())
    await expect(decisions).toBeVisible()
    await expect(decisions).toHaveAttribute('data-work-decisions', '0')
    await expect(decisions.getByText(/Paired fixture needs: pick the test marker/)).toHaveCount(0)
    const afterAnswer = await readPending()
    expect(afterAnswer.map((row) => row.key)).not.toContain(decisionKey)
    await testInfo.attach('exact-native-key-resolved-after-work-remount', {
      body: Buffer.from(
        JSON.stringify({ decisionKey, afterAnswer, inputReceipts: inputs() }, null, 2)
      ),
      contentType: 'application/json'
    })
  } finally {
    await diagnostics('after-decisions-click')
  }
})
