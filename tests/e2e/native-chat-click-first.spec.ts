import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Automation } from '../../src/shared/automations-types'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

test('shows recommendations, hides tool noise, opens Prompt Engineer, and converts a conversation into a routine', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const sessionId = `e2e-actions-${randomUUID()}`
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-actions-'))
  const transcriptPath = path.join(scratch, `${sessionId}.jsonl`)
  const submittedPath = path.join(scratch, 'submitted-prompt.txt')
  const provider = path.join(scratch, 'engineer-provider.cjs')
  writeFileSync(
    provider,
    `
const fs = require('node:fs');
const transcriptPath = ${JSON.stringify(transcriptPath)};
const sessionId = ${JSON.stringify(sessionId)};
let input = '', turns = 0;
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.title = 'claude';
process.stdout.write('\\x1b[?2004h\\x1b]0;✳ Claude Code\\x07');
fs.writeFileSync(${JSON.stringify(submittedPath)}, 'ready');
function append(role, text) {
  fs.appendFileSync(transcriptPath, JSON.stringify({ sessionId, uuid: role + '-' + turns,
    type: role, timestamp: new Date().toISOString(),
    message: { role, content: [{ type: 'text', text }] } }) + '\\n');
}
process.stdin.on('data', chunk => {
  input += chunk.toString();
  const start = input.indexOf('\\x1b[200~'), end = input.indexOf('\\x1b[201~');
  let prompt;
  if (start >= 0) {
    if (end < 0 || !input.slice(end + 6).includes('\\r')) return;
    prompt = input.slice(start + 6, end);
  } else {
    const enter = input.indexOf('\\r');
    if (enter < 0) return;
    prompt = input.slice(0, enter).replace(/^[\\x00-\\x1f]+/, '');
  }
  input = ''; turns++;
  append('user', prompt);
  process.stdout.write('\\x1b]9999;' + JSON.stringify({ state: 'working', agentType: 'claude', prompt }) + '\\x07');
  setTimeout(() => {
    const reply = prompt.startsWith('Go.') ? 'Prompt execution completed' :
      'Revised prompt:\\nDraft a registration test plan for students.\\nQuestions:\\nWhich devices?';
    append('assistant', reply);
    process.stdout.write('\\x1b]9999;' + JSON.stringify({ state: 'done', agentType: 'claude', lastAssistantMessage: reply }) + '\\x07');
  }, 2000);
});
setTimeout(() => process.exit(0), 90000);
`
  )
  const prompt = 'Check the registration flow every morning'
  writeFileSync(
    transcriptPath,
    `${[
      {
        sessionId,
        uuid: 'user',
        type: 'user',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: prompt }] }
      },
      {
        sessionId,
        uuid: 'tools',
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'check',
              name: 'Bash',
              input: { command: 'echo TECHNICAL_DETAILS_PROOF' }
            }
          ]
        }
      },
      {
        sessionId,
        uuid: 'result',
        type: 'user',
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'check', content: 'TECHNICAL_DETAILS_PROOF' }
          ]
        }
      },
      {
        sessionId,
        uuid: 'assistant',
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I recommend giving this to another AI.' }]
        }
      }
    ]
      .map((line, index) =>
        JSON.stringify({ ...line, timestamp: new Date(Date.now() + index * 100).toISOString() })
      )
      .join('\n')}\n`
  )
  const tabId = await orcaPage.evaluate(
    async (command) => {
      const state = window.__store!.getState()
      await state.updateSettingsOrThrow({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agentCmdOverrides: { claude: command }
      })
      const tab = state.createTab(state.activeWorktreeId!, undefined, undefined, {
        launchAgent: 'claude',
        viewMode: 'chat',
        pendingStartup: { command, launchAgent: 'claude', startupCommandDelivery: 'shell-ready' }
      } as never)
      state.setActiveTabType('terminal')
      return tab.id
    },
    `${JSON.stringify(process.execPath)} ${JSON.stringify(provider)}`
  )
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await expect.poll(() => existsSync(submittedPath), { timeout: 30_000 }).toBe(true)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const starRequest = orcaPage.getByRole('complementary', { name: 'Enjoying OmniConsole?' })
  try {
    // A completed turn may open the star request over Go after its visibility check.
    await orcaPage.addLocatorHandler(starRequest, async () => {
      await starRequest.getByRole('button', { name: 'Dismiss', exact: true }).click()
    })
    await orcaPage.evaluate(
      async ({ descriptor, sessionId, transcriptPath }) => {
        const state = window.__store!.getState()
        await state.updateSettingsOrThrow({ experimentalNativeChat: true })
        state.setSidebarSessionSurface('sessions')
        state.setAgentStatus(
          descriptor.paneKey,
          {
            state: 'done',
            prompt: '',
            agentType: 'claude'
          },
          'Claude',
          undefined,
          { worktreeId: descriptor.worktreeId },
          { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
        )
      },
      { descriptor, sessionId, transcriptPath }
    )
    const chat = orcaPage.locator('[data-native-chat-root="true"]').first()
    await expect(
      chat.getByText('I recommend giving this to another AI.', { exact: true }).first()
    ).toBeVisible()
    await expect(
      chat
        .getByRole('region', { name: 'Suggested next steps', exact: true })
        .getByRole('button', { name: 'Run: Giving this to another AI', exact: true })
    ).toBeVisible()
    const header = orcaPage.locator('[data-conversation-work-header]').first()
    const contextToggle = header.getByRole('button', { name: 'Session context & outcome' })
    await contextToggle.click()
    const context = header.getByRole('region', { name: 'Session context', exact: true })
    await expect(context).toBeVisible()
    await expect(context.getByRole('button', { name: 'OmniOS & Slite', exact: true })).toBeVisible()
    // The checkmark keeps context editable; the retired manual plan composer stays absent.
    await expect(header.getByRole('button', { name: '+ Agent Review', exact: true })).toHaveCount(0)
    await expect(header.getByRole('button', { name: '+ Agent Handoff', exact: true })).toHaveCount(
      0
    )
    await contextToggle.click()
    // Tool noise is folded: the run reads as ONE collapsed summary row, and neither its
    // per-tool lines nor the tool's output are on screen until the person opens it.
    const toolRun = chat.getByRole('button', { name: /^1×/ })
    await expect(toolRun).toHaveAttribute('aria-expanded', 'false')
    await expect(chat.getByRole('button', { name: /^Result/ })).toHaveCount(0)
    await expect(chat.locator('pre').filter({ hasText: 'TECHNICAL_DETAILS_PROOF' })).toHaveCount(0)
    const newConversation = orcaPage.locator('[data-new-conversation]')
    await expect(newConversation).toBeVisible()
    await expect(newConversation).toHaveAccessibleName('New conversation')
    const folderBounds = await orcaPage
      .getByRole('button', { name: 'New folder', exact: true })
      .boundingBox()
    const newBounds = await newConversation.boundingBox()
    expect(folderBounds && newBounds && folderBounds.x < newBounds.x).toBeTruthy()
    await newConversation.click()
    await expect(orcaPage.getByText('New conversation', { exact: true }).last()).toBeVisible()
    await orcaPage.keyboard.press('Escape')
    await orcaPage.screenshot({ path: testInfo.outputPath('chat-after.png') })
    await toolRun.click()
    await expect(toolRun).toHaveAttribute('aria-expanded', 'true')
    // Opened, the run lists its lines: the command it ran and the output it returned.
    await expect(
      chat.getByRole('button', { name: /^Bash\s*echo TECHNICAL_DETAILS_PROOF/ })
    ).toBeVisible()
    await expect(
      chat.getByRole('button', { name: /^Result\s*TECHNICAL_DETAILS_PROOF/ })
    ).toBeVisible()
    // The fake provider runs in the existing PTY; the wizard must never launch another tab.
    const tabCount = await orcaPage.locator('[data-testid="sortable-tab"]').count()
    await chat.getByRole('button', { name: 'Prompt Engineer', exact: true }).click()
    await expect(orcaPage.getByRole('dialog')).toHaveCount(0)
    const composer = chat.locator('textarea').first()
    await expect(composer).toBeFocused()
    await composer.fill('A registration test plan for students')
    await composer.press('Enter')
    await expect(chat.getByRole('button', { name: 'Stop the agent', exact: true })).toBeVisible()
    await expect(chat.getByRole('button', { name: 'Go', exact: true })).toBeDisabled()
    await expect(chat.getByText('Which devices?', { exact: false })).toBeVisible()
    await expect(chat.getByRole('button', { name: 'Go', exact: true })).toBeEnabled()
    await orcaPage.screenshot({ path: testInfo.outputPath('prompt-engineer.png') })
    await chat.getByRole('button', { name: 'Go', exact: true }).click()
    await expect(chat.getByText('Prompt execution completed', { exact: true })).toBeVisible()
    await expect(chat.getByRole('button', { name: 'Go', exact: true })).toHaveCount(0)
    await expect(orcaPage.locator('[data-testid="sortable-tab"]')).toHaveCount(tabCount)
    await orcaPage.evaluate(
      ({ descriptor, prompt, sessionId, transcriptPath, tabId }) => {
        const state = window.__store!.getState()
        state.setSidebarSessionSurface('sessions')
        state.setTabCustomTitle(tabId, prompt)
        state.setAgentStatus(
          descriptor.paneKey,
          { state: 'done', prompt, agentType: 'claude' },
          'Claude',
          undefined,
          { worktreeId: descriptor.worktreeId },
          { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
        )
      },
      { descriptor, prompt, sessionId, transcriptPath, tabId }
    )
    const doneGroup = orcaPage.getByRole('group', { name: /^Done \(\d+\)$/ })
    const doneToggle = doneGroup.getByRole('button', { name: /^(Expand|Collapse) Done \(/ })
    await expect(doneToggle).toBeVisible()
    if ((await doneToggle.getAttribute('aria-expanded')) === 'false') {
      await doneToggle.click()
    }
    const source = doneGroup
      .locator('[data-session-key][draggable="true"]')
      .filter({ hasText: prompt })
      .first()
    await expect(source).toBeVisible()
    const dropTarget = orcaPage.locator('[data-routine-drop-target]')
    await expect(dropTarget).toBeVisible()
    // Start on the row padding, outside the interactive title and selection controls.
    await source.dragTo(dropTarget, { sourcePosition: { x: 4, y: 4 } })
    const routine = orcaPage.getByRole('dialog', { name: 'Create automation', exact: true })
    await expect(routine).toBeVisible()
    await expect(routine.getByRole('combobox', { name: 'Cadence', exact: true })).toHaveText(
      'Daily'
    )
    await expect(routine.getByRole('textbox', { name: 'Hour', exact: true })).toHaveValue('9')
    await expect(routine.getByRole('textbox', { name: 'Minute', exact: true })).toHaveValue('00')
    await expect(routine.getByRole('button', { name: 'AM or PM: AM', exact: true })).toBeVisible()
    await expect(
      routine.getByRole('textbox', { name: 'Automation name', exact: true })
    ).toHaveValue(prompt)
    await orcaPage.screenshot({ path: testInfo.outputPath('conversation-routine.png') })
    await routine.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(routine).not.toBeVisible()
    await expect(
      orcaPage.locator('[data-automation-row-id]').filter({ hasText: prompt })
    ).toBeVisible()
    const saved = await orcaPage.evaluate(async (name) => {
      const response = await window.api.runtime.call({ method: 'automation.list' })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return (response.result as { automations: Automation[] }).automations.find(
        (automation) => automation.name === name
      )
    }, prompt)
    expect(saved).toMatchObject({
      name: prompt,
      agentId: 'claude',
      workspaceId: descriptor.worktreeId,
      workspaceMode: 'existing',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      prompt: expect.stringContaining('registration')
    })
  } finally {
    await orcaPage.removeLocatorHandler(starRequest).catch(() => undefined)
    rmSync(scratch, { recursive: true, force: true })
  }
})
