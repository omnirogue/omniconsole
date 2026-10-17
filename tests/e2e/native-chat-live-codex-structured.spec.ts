import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../src/shared/structured-agent-session-mutation'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { folderWorkspaceKey } from '../../src/shared/workspace-scope'

/**
 * Live check of the app-server ("structured") Codex chat against the REAL CLI. Opt-in:
 *
 *   OMNI_LIVE_CODEX=/Users/me/.local/opt/node/bin/codex pnpm exec playwright test tests/e2e/native-chat-live-codex-structured.spec.ts ...
 *
 * The host's Codex authentication is copied into a temporary CODEX_HOME that the
 * session pins through the agent env, so nothing on the host is touched.
 */
const LIVE_CODEX = process.env.OMNI_LIVE_CODEX ?? ''
const PROMPT =
  'UI diagnostic only. Reply exactly CODEX-STRUCTURED-READY. Do not use tools or change files.'

test.skip(!LIVE_CODEX, 'set OMNI_LIVE_CODEX=<absolute codex path> to run the live structured check')
test.use({
  seedTestRepo: false,
  launchEnv: { PATH: `${path.dirname(LIVE_CODEX)}:${process.env.PATH ?? ''}` }
})

test('real Codex app-server: native menus and live chat steering', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(420_000)
  // Why $HOME/.codex: the app's Codex launch preparation pins the pane's CODEX_HOME to the
  // "real-home" route ($HOME/.codex) when no managed account is selected, so a free temp dir
  // would be ignored. The harness HOME is disposable and removed after the test.
  const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
  if (isolatedHome === os.homedir()) {
    throw new Error('refusing to seed credentials into the developer home')
  }
  const codexHome = path.join(isolatedHome, '.codex')
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  const authPath = path.join(os.homedir(), '.codex', 'auth.json')
  if (existsSync(authPath)) {
    copyFileSync(authPath, path.join(codexHome, 'auth.json'))
  }
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"\n'
  )
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async (codexHome) => {
    await window.__store!.getState().updateSettings({
      defaultTuiAgent: 'codex',
      agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' },
      agentDefaultEnv: { codex: { CODEX_HOME: codexHome } },
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
      experimentalStructuredNativeChat: true
    })
  }, codexHome)

  // Seed the real session through its public RPC; disposable-account usage discovery
  // is a separate contract from the composer behavior exercised through the UI below.
  const workspacePath = path.join(isolatedHome, 'chat-steering-check')
  mkdirSync(workspacePath, { recursive: true })
  const folderId = await orcaPage.evaluate(async (folderPath) => {
    const group = await window.api.projectGroups.create({
      name: 'Chat steering check',
      parentPath: folderPath,
      createdFrom: 'manual'
    })
    const folder = await window.api.folderWorkspaces.create({
      name: 'Chat steering check',
      folderPath,
      projectGroupId: group.id
    })
    await window.__store!.getState().fetchProjectGroups()
    await window.__store!.getState().fetchFolderWorkspaces()
    return folder.id
  }, workspacePath)
  const worktreeId = folderWorkspaceKey(folderId)
  await orcaPage.evaluate((id) => window.__store!.getState().setActiveWorktree(id), worktreeId)
  const sessionId = `codex_${randomUUID().replaceAll('-', '_')}`
  const fields = {
    worktree: worktreeId.startsWith('id:') ? worktreeId : `id:${worktreeId}`,
    agent: 'codex',
    options: {
      chatPermissionMode: 'bypass',
      approvalPolicy: 'never'
    }
  }
  const params = {
    ...fields,
    envelope: {
      sessionId,
      clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
      expectedRuntimeFence: null,
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId,
        fields
      })
    }
  }
  const launched = await orcaPage.evaluate(
    async (params) => window.api.runtime.call({ method: 'agentSession.create', params }),
    params
  )
  expect(launched, JSON.stringify(launched)).toMatchObject({ ok: true, result: { ok: true } })
  await expect(
    orcaPage.locator(`[data-testid="sortable-tab"]`).filter({ hasText: /Codex/i }).last()
  ).toBeVisible({ timeout: 60_000 })
  await orcaPage
    .locator(`[data-testid="sortable-tab"]`)
    .filter({ hasText: /Codex/i })
    .last()
    .click()

  const chat = orcaPage.locator('[data-native-chat-root="true"]').first()
  await expect(chat).toBeVisible({ timeout: 120_000 })
  await orcaPage.screenshot({ path: testInfo.outputPath('01-structured-chat.png') })

  const liveOptions = await orcaPage.evaluate(
    async (sessionId) =>
      window.api.runtime.call({ method: 'agentSession.options', params: { sessionId } }),
    sessionId
  )
  expect(liveOptions, JSON.stringify(liveOptions)).toMatchObject({
    ok: true,
    result: { supportsLiveInput: true }
  })
  // Native pickers: the Model pill lists app-server models; the options pill lists efforts.
  const modelPill = chat.getByRole('button', { name: /Model/ }).first()
  await expect(modelPill).toBeVisible({ timeout: 60_000 })
  await modelPill.click()
  const modelRows = orcaPage.getByRole('menuitemradio')
  await expect.poll(() => modelRows.count(), { timeout: 60_000 }).toBeGreaterThan(1)
  const modelNames = await modelRows.allInnerTexts()
  test.info().annotations.push({ type: 'models', description: modelNames.join(' | ') })
  await orcaPage.screenshot({ path: testInfo.outputPath('02-model-menu.png') })
  await orcaPage.keyboard.press('Escape')
  expect(modelNames.join('\n')).not.toContain('Choose in agent picker')

  const composer = chat.locator('textarea').first()
  await expect(composer).toBeVisible({ timeout: 60_000 })
  await composer.fill(PROMPT)
  await composer.press('Enter')
  // The real model's reply echoes the marker; the user turn shows it once.
  await expect(chat.getByText('CODEX-STRUCTURED-READY').nth(1)).toBeVisible({ timeout: 240_000 })
  await orcaPage.screenshot({ path: testInfo.outputPath('03-answered.png') })
  const text = await chat.innerText()
  test.info().annotations.push({
    type: 'chat-text',
    description: text.replace(/\n/g, ' | ').slice(0, 2000)
  })
  // Exactly one accepted user turn.
  expect(
    (text.match(/UI diagnostic only\. Reply exactly CODEX-STRUCTURED-READY/g) ?? []).length
  ).toBe(1)

  // Effort menu lists the levels Codex advertises for the current model and shows the applied one.
  const optionsPill = chat.getByRole('button', { name: /Effort|Reasoning/ }).first()
  await expect(optionsPill).toBeVisible({ timeout: 30_000 })
  await optionsPill.click()
  const effortRows = orcaPage.getByRole('menuitemradio')
  await expect.poll(() => effortRows.count(), { timeout: 30_000 }).toBeGreaterThan(1)
  const efforts = await effortRows.allInnerTexts()
  test.info().annotations.push({ type: 'efforts', description: efforts.join(' | ') })
  await orcaPage.screenshot({ path: testInfo.outputPath('04-effort-menu.png') })
  expect(efforts.join('\n')).toMatch(/High/)
  await effortRows.filter({ hasText: /^Medium/ }).click()
  await expect(optionsPill).toContainText('Medium')

  await composer.fill(
    'UI steering diagnostic only. Run the shell command sleep 12. After it finishes, follow my next correction for your final response. Do not inspect or modify files or delegate.'
  )
  await composer.press('Enter')
  await expect(chat).toHaveAttribute('data-native-chat-working', 'true', { timeout: 60_000 })
  await expect(chat.getByRole('button', { name: 'Stop the agent', exact: true })).toBeEnabled()
  await composer.fill('Correction: reply exactly CODEX-STEERED-OK after the sleep finishes.')
  await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await expect(chat.getByRole('button', { name: /Queue.*after current/ })).toHaveCount(0)
  await chat.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(chat.getByText('CODEX-STEERED-OK', { exact: true }).first()).toBeVisible({
    timeout: 180_000
  })
  await expect(chat).toHaveAttribute('data-native-chat-working', 'false', { timeout: 60_000 })
  const corrected = await chat.innerText()
  expect(corrected.match(/Correction: reply exactly CODEX-STEERED-OK/g)).toHaveLength(1)
  expect(corrected).not.toMatch(/delivery unconfirmed|turn already running/i)
  await orcaPage.screenshot({ path: testInfo.outputPath('05-live-steering.png') })
  await composer.fill(
    'UI stop diagnostic only. Run sleep 30 before replying STOP-DIAGNOSTIC-DONE. Do not inspect or change files.'
  )
  await composer.press('Enter')
  await expect(chat).toHaveAttribute('data-native-chat-working', 'true', { timeout: 60_000 })
  await chat.getByRole('button', { name: 'Stop the agent', exact: true }).click()
  await expect(chat).toHaveAttribute('data-native-chat-working', 'false', { timeout: 30_000 })
  await expect(chat.getByRole('button', { name: 'Stop the agent', exact: true })).toHaveCount(0)
  expect(await chat.innerText()).not.toMatch(/Message delivery is unconfirmed/)
  await orcaPage.screenshot({ path: testInfo.outputPath('06-stopped.png') })
  // The fixture stops the runtime before removing its isolated home.
})
