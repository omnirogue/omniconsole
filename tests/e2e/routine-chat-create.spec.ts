import { captureRoutineProof } from './helpers/routine-proof-evidence'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

// A deterministic provider calls the real authenticated CLI after a prompt is submitted in Chat.
test('a chat creates a separate routine, receives the system line and remains in Conversations', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const directory = mkdtempSync(join(tmpdir(), 'routine-chat-create-'))
  const script = join(directory, 'provider.cjs')
  const ready = join(directory, 'ready')
  const sessionId = randomUUID()
  const transcriptPath = join(directory, `${sessionId}.jsonl`)
  writeFileSync(transcriptPath, '')
  writeFileSync(
    script,
    `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
let input = '', started = false;
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdout.write('\\x1b[?2004h\\x1b]0;Claude Code\\x07');
fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
const status = (state, extra) => process.stdout.write('\\x1b]9999;' + JSON.stringify({state, agentType:'claude', ...extra}) + '\\x07');
function append(role, text) { fs.appendFileSync(${JSON.stringify(transcriptPath)}, JSON.stringify({sessionId:${JSON.stringify(sessionId)}, uuid:role, type:role, timestamp:new Date().toISOString(), message:{role, content:[{type:'text', text}]}}) + '\\n'); }
process.stdin.on('data', chunk => {
  if (started) return;
  input += chunk.toString();
  const start = input.indexOf('\\x1b[200~'), end = input.indexOf('\\x1b[201~');
  if (start >= 0 ? end < 0 || !input.slice(end + 6).includes('\\r') : !input.includes('\\r')) return;
  const prompt = start >= 0 ? input.slice(start + 6, end) : input.slice(0, input.indexOf('\\r'));
  started = true; append('user', prompt); status('working', {prompt});
  const result = spawnSync(process.execPath, [${JSON.stringify(join(process.cwd(), 'out/cli/index.js'))}, 'automations', 'create', '--name', 'Chat-created briefing', '--prompt', 'Summarize the project each morning.', '--provider', 'claude', '--trigger', 'daily', '--time', '09:00', '--disabled', '--json'], {encoding:'utf8', env:process.env, timeout:15000, windowsHide:true});
  const reply = result.status === 0 ? 'Created your separate routine.' : 'CLI creation failed: ' + (result.stderr || result.error || result.status);
  append('assistant', reply); status('done', {lastAssistantMessage:reply});
});
setTimeout(() => process.exit(0), 110000);
`
  )
  try {
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
      `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
    )
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await expect.poll(() => existsSync(ready), { timeout: 30_000 }).toBe(true)
    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    await orcaPage.evaluate(
      ({ descriptor, sessionId, transcriptPath }) => {
        window
          .__store!.getState()
          .setAgentStatus(
            descriptor.paneKey,
            { state: 'done', prompt: '', agentType: 'claude' },
            'Claude',
            undefined,
            { worktreeId: descriptor.worktreeId },
            { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
          )
      },
      { descriptor, sessionId, transcriptPath }
    )
    const chat = orcaPage.locator('[data-native-chat-root="true"]:visible').first()
    await chat
      .locator('textarea')
      .first()
      .fill('Create a routine named Chat-created briefing to summarize this project every morning.')
    await chat.locator('textarea').first().press('Enter')
    await expect(orcaPage.locator('[data-routine-created]')).toHaveText(
      "Routine 'Chat-created briefing' created. Open it from Conversations.",
      { timeout: 30_000 }
    )
    await expect(orcaPage.locator('[data-routine-conversation]')).toHaveCount(0)
    await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
    await expect(orcaPage.locator(`[data-session-row*="${tabId}"]`)).toBeVisible()
    await captureRoutineProof(orcaPage, testInfo, 'chat-created-conversations')
    await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
    const routine = orcaPage.getByRole('button', {
      name: 'Open routine Chat-created briefing',
      exact: true
    })
    await expect(routine).toBeVisible()
    await captureRoutineProof(orcaPage, testInfo, 'chat-created-routines')
    await routine.click()
    await expect(
      orcaPage.locator('[data-testid="sortable-tab"][data-active="true"]')
    ).not.toHaveAttribute('data-tab-id', tabId)
    await expect(orcaPage.locator('[data-routine-conversation]')).toContainText(
      'Chat-created briefing'
    )
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})
