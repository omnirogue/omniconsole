import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  launchGoldenStubAgentIntoChat,
  GOLDEN_STUB_READY_MARKER
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForTerminalOutput } from './helpers/terminal'

// Outcome writes require the same single-instance ownership as the packaged app.
test.use({
  launchEnv: { ...getGoldenStubAgentLaunchEnv(), ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1' }
})

test('information disclosures retain history and edits and use real outcome and queue writes', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await configureGoldenStubAgent(orcaPage, { agent: 'codex', chatView: true })
  await launchGoldenStubAgentIntoChat(orcaPage, 'codex')
  // The isolated Codex trust probe can consume 10s before the stub PTY starts.
  await waitForTerminalOutput(orcaPage, GOLDEN_STUB_READY_MARKER, 20_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const sessionId = randomUUID()
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-chat-information-'))
  const transcriptPath = path.join(scratch, 'conversation.jsonl')
  writeFileSync(
    transcriptPath,
    `${[
      ['user_message', 'Review chat reliability without removing any controls.'],
      ['agent_message', 'The existing conversation and its context are available.']
    ]
      .map(([type, message]) =>
        JSON.stringify({
          type: 'event_msg',
          timestamp: new Date().toISOString(),
          payload: { type, message }
        })
      )
      .join('\n')}\n`
  )
  try {
    await orcaPage.evaluate(
      ({ descriptor, sessionId, transcriptPath }) => {
        window
          .__store!.getState()
          .setAgentStatus(
            descriptor.paneKey,
            { state: 'working', prompt: 'Review chat reliability', agentType: 'codex' },
            'Codex',
            undefined,
            { worktreeId: descriptor.worktreeId },
            { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
          )
      },
      { descriptor, sessionId, transcriptPath }
    )
    const chat = orcaPage.locator('[data-native-chat-root="true"]').first()
    const header = orcaPage.locator('[data-conversation-work-header]').first()
    const draft = chat.locator('[data-native-chat-composer-input]')
    await expect(
      chat.getByText('The existing conversation and its context are available.', { exact: true })
    ).toBeVisible()
    await draft.fill('Keep this draft while I check the details.')
    const toggles = header.locator('[data-conversation-information-toggle]')
    await expect(toggles).toHaveText(['', ''])
    await expect(toggles.nth(0)).toHaveAttribute('aria-label', 'Session details')
    await expect(toggles.nth(1)).toHaveAttribute('aria-label', 'Session context & outcome')
    await expect(header.locator('[data-conversation-information-panel]:visible')).toHaveCount(0)
    await header.getByRole('button', { name: 'Session details', exact: true }).click()
    const details = header.locator('[data-conversation-information-panel="details"]')
    // Agent, location and workspace share one line; an unlinked task waits under More.
    await expect(details.locator('[data-next-action-where]')).toBeVisible()
    await expect(details.locator('[data-session-activity]')).toBeVisible()
    // This fixture's tab was created without a launch record, which never reads as Default.
    const agentRow = details.locator('[data-next-action-fact="agent-template"]')
    const agentName = agentRow.locator('[data-agent-template-name]')
    await expect(agentName).toHaveText('Not recorded')
    const recordTemplate = (digest: string) =>
      orcaPage.evaluate(
        ({ paneKey, digest }) => {
          const tabId = paneKey.slice(0, paneKey.lastIndexOf(':'))
          window
            .__store!.getState()
            .setTabAgentTemplate(tabId, { id: 'developer', name: 'Developer', digest })
        },
        { paneKey: descriptor.paneKey, digest }
      )
    // The shipped Developer text's digest, so the row reads current.
    await recordTemplate('1f319edbed97')
    await expect(agentName).toHaveText('Developer')
    await expect(agentRow.locator('[data-agent-template-changed]')).toHaveCount(0)
    await expect(agentRow.getByRole('button', { name: 'Edit instructions…' })).toBeVisible()
    await recordTemplate('000000000000')
    await expect(agentRow.locator('[data-agent-template-changed]')).toHaveText(
      'Instructions changed since this session started'
    )
    await details.getByText('More', { exact: true }).click()
    await expect(details.getByText('Task', { exact: true })).toBeVisible()
    await expect(details.getByText('Receipts', { exact: true })).toBeVisible()
    await expect(details.getByText('First recorded request', { exact: true })).toBeVisible()
    await expect(details).toContainText('Review chat reliability without removing any controls.')
    const outcomeToggle = header.getByRole('button', { name: 'Session context & outcome' })
    await outcomeToggle.click()
    const outcome = header.locator('[data-conversation-information-panel="outcome"]')
    await outcome.getByRole('button', { name: 'Set outcome', exact: true }).click()
    const sentence = outcome.getByRole('textbox', { name: 'Outcome sentence', exact: true })
    await sentence.fill('Preserve all chat functionality with clearer information.')
    await header.getByRole('button', { name: 'Session details', exact: true }).click()
    await outcomeToggle.click()
    await expect(sentence).toHaveValue('Preserve all chat functionality with clearer information.')
    await expect(draft).toHaveValue('Keep this draft while I check the details.')
    await outcome.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(sentence).toBeHidden({ timeout: 30_000 })
    if (!(await outcome.isVisible())) {
      await outcomeToggle.click()
    }
    await expect(outcome.locator('[data-next-action-outcome-sentence]')).toHaveText(
      'Preserve all chat functionality with clearer information.'
    )
    // The hand-built Up next composer is retired; attached instructions use the live editor.
    const context = outcome.locator('[data-session-context-editor]')
    await context.getByRole('button', { name: 'Instructions', exact: true }).click()
    const instructions = context.getByRole('textbox', {
      name: 'Custom session instructions',
      exact: true
    })
    await instructions.fill('Check the final result.')
    await header.getByRole('button', { name: 'Session details', exact: true }).click()
    await outcomeToggle.click()
    await expect(instructions).toHaveValue('Check the final result.')
    await context.getByRole('button', { name: 'Add instructions', exact: true }).click()
    const attachment = context.getByRole('button', {
      name: 'Remove Check the final result.',
      exact: true
    })
    await expect(attachment).toBeVisible()
    // This fixture's renderer-only provider id cannot prove a host receiver identity.
    await expect(context.getByRole('status')).toHaveText(
      /^(Saved and queued for this session\.|Saved\. (Context will be included in the next chat message\.|Delivery could not be confirmed; context remains available for the next chat message\.))$/,
      { timeout: 30_000 }
    )
    await header.getByRole('button', { name: 'Session details', exact: true }).click()
    await outcomeToggle.click()
    await expect(attachment).toBeVisible()
    await expect(outcome.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0)
    // Seed the real queue independently of the fixture's fabricated provider identity.
    const queueId = randomUUID()
    await orcaPage.evaluate(
      async ({ descriptor, queueId }) => {
        const response = await window.api.runtime.call({
          method: 'promptQueue.enqueue',
          params: {
            source: { worktreeId: descriptor.worktreeId, paneKey: descriptor.paneKey, kind: 'pty' },
            id: queueId,
            text: 'Check the final result.'
          }
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
      },
      { descriptor, queueId }
    )
    await expect(outcome.locator(`[data-up-next-block="pq:${queueId}"]`)).toBeVisible({
      timeout: 30_000
    })
    if (await outcome.isVisible()) {
      await outcomeToggle.click()
    }
    await expect(draft).toHaveValue('Keep this draft while I check the details.')
    for (const theme of ['light', 'dark'] as const) {
      await orcaPage.evaluate(async (theme) => {
        await window.__store!.getState().updateSettingsOrThrow({ theme })
      }, theme)
      await orcaPage.screenshot({ path: testInfo.outputPath(`information-${theme}.png`) })
    }
    await header.evaluate((element) => {
      element.style.width = '320px'
      element.style.maxWidth = '320px'
    })
    const widths = await header.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth
    }))
    expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
