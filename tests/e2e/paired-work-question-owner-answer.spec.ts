import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { configureGoldenStubAgent, getGoldenStubAgentLaunchEnv } from './helpers/golden-stub-agent'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import {
  getTerminalContent,
  waitForActivePaneHookDescriptor,
  waitForTerminalOutput
} from './helpers/terminal'
import { createPairedQuestionProcessProof } from './helpers/paired-question-process-proof'
import { SESSION_QUESTION_OWNER_ANSWER_CAPABILITY } from '../../src/shared/session-question-owner-answer'

const scratch = path.join(os.tmpdir(), `orca-paired-question-${randomUUID()}`)
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

test('paired Work answers through the real owner and refuses a replaced screen', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(300_000)
  const processes = createPairedQuestionProcessProof(testInfo, registerPostElectronShutdownCleanup)
  const ownerUserData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  await processes.record('owner:main', electronApp.process().pid!)
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
  const auditPath = path.join(ownerUserData, 'session-actions.jsonl')
  const fixturePid = Number(
    /\[GOLDEN_STUB_AGENT_PID\] (\d+)/.exec(await getTerminalContent(orcaPage))?.[1]
  )
  await processes.record('owner:native-question-fixture', fixturePid)
  await processes.recordProfile('owner', ownerUserData, electronApp.process().pid!)
  const sessionId = randomUUID()
  const arm = (revision: string, screenOnly = false) =>
    writeFileSync(
      controlPath,
      JSON.stringify({
        revision,
        screenOnly,
        endpoint,
        sessionId,
        receiptPath,
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId
      }),
      { mode: 0o600 }
    )
  arm('blue')
  await waitForTerminalOutput(orcaPage, 'Paired fixture blue: pick the test marker', 15_000)

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'Question owner fixture')
  try {
    await processes.recordProfile('client', client.userDataDir, client.app.process().pid!)
    await client.page.evaluate(() => window.__store!.getState().openWorkPage())
    const needsYou = client.page.getByRole('region', { name: 'Needs you', exact: true })
    const card = needsYou.locator('[data-needs-you-question]')
    await expect(needsYou.getByText(/Paired fixture blue: pick the test marker/)).toBeVisible({
      timeout: 45_000
    })
    await expect(needsYou.getByRole('button', { name: /Blue/ })).toBeEnabled({ timeout: 30_000 })
    await client.page.screenshot({ path: testInfo.outputPath('paired-question-ready.png') })

    // Only this legacy-capability display is simulated; the answer below uses real paired RPC.
    const capabilities = await client.page.evaluate(
      ({ environmentId, capability }) => {
        const store = window.__store!
        const statuses = new Map(store.getState().runtimeStatusByEnvironmentId)
        const entry = statuses.get(environmentId)!
        const previous = entry.status!.capabilities ?? []
        statuses.set(environmentId, {
          ...entry,
          status: {
            ...entry.status!,
            capabilities: previous.filter((value) => value !== capability)
          }
        })
        store.setState({ runtimeStatusByEnvironmentId: statuses })
        return previous
      },
      { environmentId: client.environmentId, capability: SESSION_QUESTION_OWNER_ANSWER_CAPABILITY }
    )
    await expect(
      needsYou.getByText(
        'Update this session’s computer to answer here. You can still open the session.'
      )
    ).toBeVisible()
    await expect(needsYou.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    await expect(needsYou.getByRole('button', { name: /Blue/ })).toHaveCount(0)
    await client.page.evaluate(
      ({ environmentId, capabilities }) => {
        const store = window.__store!
        const statuses = new Map(store.getState().runtimeStatusByEnvironmentId)
        const entry = statuses.get(environmentId)!
        statuses.set(environmentId, { ...entry, status: { ...entry.status!, capabilities } })
        store.setState({ runtimeStatusByEnvironmentId: statuses })
      },
      { environmentId: client.environmentId, capabilities }
    )
    await expect(needsYou.getByRole('button', { name: /Blue/ })).toBeEnabled()
    await needsYou.getByRole('button', { name: /Blue/ }).click()
    await expect(needsYou.getByText(/Paired fixture blue: pick the test marker/)).toHaveCount(0)
    await waitForTerminalOutput(orcaPage, 'FLEET_UI_RECEIPT_blue=Blue', 15_000)
    expect(inputs()).toEqual([{ revision: 'blue', input: '1' }])
    await expect
      .poll(() => {
        try {
          return readFileSync(auditPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
            .filter((row) => row.action === 'answer')
        } catch {
          return []
        }
      })
      .toEqual([
        expect.objectContaining({
          actor: 'remote',
          target: expect.objectContaining({ paneKey: descriptor.paneKey }),
          remote: expect.objectContaining({
            peer: expect.stringMatching(/^paired:/),
            requester: 'person'
          }),
          after: expect.objectContaining({ delivery: 'confirmed' })
        })
      ])

    arm('stale')
    await expect(needsYou.getByText(/Paired fixture stale: pick the test marker/)).toBeVisible()
    await expect(needsYou.getByRole('button', { name: /Green/ })).toBeEnabled()
    // A provider can repaint before its hook arrives; the owner's current screen must win.
    arm('replacement', true)
    await waitForTerminalOutput(
      orcaPage,
      'Paired fixture replacement: pick the test marker',
      15_000
    )
    await needsYou.getByRole('button', { name: /Green/ }).click()
    await expect(card.getByRole('status')).toContainText(/question|screen|session/i)
    await expect(needsYou.getByRole('button', { name: /Green/ })).toHaveCount(0)
    expect(inputs()).toEqual([{ revision: 'blue', input: '1' }])
    await expect(needsYou.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    await client.page.screenshot({ path: testInfo.outputPath('paired-question-refused.png') })
    const directSshAttempts = await client.getDirectSshAttemptTargetIds()
    expect(directSshAttempts).toEqual([])
    const proofPath = testInfo.outputPath('paired-question-owner-proof.json')
    writeFileSync(
      proofPath,
      JSON.stringify(
        {
          receivedInputs: inputs(),
          directSshAttempts,
          refusal: await card.getByRole('status').textContent(),
          ownerAudit: readFileSync(auditPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
            .filter((row) => row.action === 'answer')
            .map((row) => ({
              ts: row.ts,
              actor: row.actor,
              remote: { peer: row.remote?.peer, requester: row.remote?.requester },
              action: row.action,
              target: { paneKey: row.target?.paneKey },
              after: { chosen: row.after?.chosen, delivery: row.after?.delivery }
            }))
        },
        null,
        2
      )
    )
    await testInfo.attach('paired-question-owner-proof', {
      path: proofPath,
      contentType: 'application/json'
    })
  } catch (error) {
    const diagnostics = await Promise.allSettled([
      orcaPage.evaluate(() => window.api.agentStatus.getSnapshot()),
      client.page.evaluate(
        async ({ environmentId, descriptor }) => {
          const state = window.__store!.getState()
          const status = state.runtimeStatusByEnvironmentId.get(environmentId)
          const mirrored = Object.values(state.agentStatusByPaneKey).find(
            (entry) => entry.providerSession?.id && entry.worktreeId === descriptor.worktreeId
          )
          const ownerRead =
            status?.status && mirrored?.interactivePrompt && mirrored.providerSession
              ? await window.api.runtimeEnvironments.call({
                  selector: environmentId,
                  method: 'sessionQuestion.read',
                  params: {
                    runtimeId: status.status.runtimeId,
                    target: {
                      worktreeId: descriptor.worktreeId,
                      paneKey: descriptor.paneKey,
                      terminal: mirrored.terminalHandle
                    },
                    displayed: {
                      interactivePrompt: mirrored.interactivePrompt,
                      stateStartedAt: mirrored.stateStartedAt,
                      agentType: mirrored.agentType,
                      providerSession: mirrored.providerSession
                    }
                  }
                })
              : null
          return { status, mirrored, ownerRead }
        },
        { environmentId: client.environmentId, descriptor }
      )
    ])
    await testInfo.attach('paired-question-owner-diagnostics', {
      body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
      contentType: 'application/json'
    })
    throw error
  } finally {
    await client.dispose()
  }
})
