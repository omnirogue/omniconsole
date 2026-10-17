import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor } from './helpers/terminal'
import { captureRoutineProof } from './helpers/routine-proof-evidence'
import { waitForRoutineWorkspace } from './helpers/routine-workspace-readiness'
import {
  makeAdvertisingDecision,
  makeAdvertisingEnvelope
} from '../../src/renderer/src/components/automations/typesafe-advertising-actions-fixtures'

test('advertising results fold away while the routine conversation stays usable', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const workspaceId = await waitForActiveWorktree(orcaPage)
  await waitForRoutineWorkspace(orcaPage, workspaceId)
  const directory = mkdtempSync(join(tmpdir(), 'routine-results-conversation-'))
  const script = join(directory, 'provider.cjs')
  const ready = join(directory, 'ready')
  const sessionId = randomUUID()
  const transcriptPath = join(directory, `${sessionId}.jsonl`)
  writeFileSync(transcriptPath, '')
  writeFileSync(
    script,
    `
const fs = require('node:fs');
let input = '';
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdout.write('\\x1b[?2004h\\x1b]0;Claude Code\\x07');
if (process.stdin.isTTY) fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
function append(role, text) { fs.appendFileSync(${JSON.stringify(transcriptPath)}, JSON.stringify({sessionId:${JSON.stringify(sessionId)}, uuid:role, type:role, timestamp:new Date().toISOString(), message:{role, content:[{type:'text', text}]}}) + '\\n'); }
process.stdin.on('data', chunk => {
  input += chunk.toString();
  const start = input.indexOf('\\x1b[200~'), end = input.indexOf('\\x1b[201~');
  if (start >= 0 ? end < 0 || !input.slice(end + 6).includes('\\r') : !input.includes('\\r')) return;
  const prompt = start >= 0 ? input.slice(start + 6, end) : input.slice(0, input.indexOf('\\r'));
  input = ''; append('user', prompt); append('assistant', 'We can discuss the report here.');
  process.stdout.write('\\x1b]9999;' + JSON.stringify({state:'done', agentType:'claude', lastAssistantMessage:'We can discuss the report here.'}) + '\\x07');
});
setTimeout(() => process.exit(0), 110000);
`
  )
  try {
    const automationId = await orcaPage.evaluate(
      async ({ workspaceId, command }) => {
        await window.__store!.getState().updateSettingsOrThrow({
          experimentalNativeChat: true,
          openAgentTabsInChatByDefault: true,
          agentCmdOverrides: { claude: command }
        })
        const created = await window.api.runtime.call({
          method: 'automation.create',
          params: {
            name: 'Advertising conversation',
            prompt: 'Review the report.',
            agentId: 'claude',
            workspaceMode: 'existing',
            workspace: `id:${workspaceId}`,
            timezone: 'UTC',
            rrule: '0 9 * * *',
            dtstart: Date.now(),
            enabled: false,
            structuredOutput: {
              provider: 'typesafe',
              contract: 'advertising.v1',
              advertising: { company: 'omnirogue', accountId: 'act_99999' }
            }
          }
        })
        if (!created.ok) {
          throw new Error(created.error.message)
        }
        return (created.result as { automation: { id: string } }).automation.id
      },
      { workspaceId, command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` }
    )
    const envelope = makeAdvertisingEnvelope({
      routineId: automationId,
      decisions: Array.from({ length: 12 }, (_, index) =>
        makeAdvertisingDecision({ id: index.toString(16).padStart(64, '0') })
      )
    })
    // Only report reads are simulated; the conversation uses a real PTY and transcript.
    await electronApp.evaluate(
      ({ ipcMain }, { automationId, envelope }) => {
        const handlers = (
          ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
        )._invokeHandlers
        const original = handlers.get('runtime:call')!
        ipcMain.removeHandler('runtime:call')
        ipcMain.handle('runtime:call', (event, request) => {
          if (request.params?.automationId === automationId) {
            if (request.method === 'automation.runs') {
              return {
                ok: true,
                result: {
                  runs: [
                    {
                      id: 'run-1',
                      automationId,
                      title: 'Advertising report',
                      createdAt: Date.now(),
                      status: 'completed',
                      terminalSessionId: null,
                      terminalPaneKey: null,
                      chatSessionId: null,
                      outputSnapshot: {
                        format: 'plain_text',
                        content: 'Prior report for review.',
                        capturedAt: Date.now(),
                        truncated: false
                      }
                    }
                  ]
                }
              }
            }
            if (request.method === 'automation.advertising.get') {
              return { ok: true, result: { envelope } }
            }
          }
          return original(event, request)
        })
      },
      { automationId, envelope }
    )
    await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
    await orcaPage
      .getByRole('button', { name: 'Open routine Advertising conversation', exact: true })
      .click()
    // A synthetic provider session must not turn an unstarted launch into a resume.
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
    const toggle = orcaPage.getByRole('button', { name: 'Run results', exact: true })
    const chat = orcaPage.locator('[data-native-chat-root="true"]:visible').first()
    const composer = chat.locator('textarea').first()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(orcaPage.getByRole('heading', { name: 'Advertising decisions' })).toBeHidden()
    await expect(composer).toBeEditable()
    await captureRoutineProof(orcaPage, testInfo, 'routine-results-collapsed-conversation')
    await toggle.click()
    await expect(orcaPage.getByRole('heading', { name: 'Advertising decisions' })).toBeVisible()
    await expect(orcaPage.getByText('Decision confidence: 93%').first()).toBeVisible()
    await expect(composer).toBeInViewport()
    await composer.fill('Explain why these ads are recommended.')
    await captureRoutineProof(orcaPage, testInfo, 'routine-results-expanded-conversation')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(composer).toHaveValue('Explain why these ads are recommended.')
    await composer.press('Enter')
    await expect(chat.getByText('We can discuss the report here.', { exact: true })).toBeVisible()
    await captureRoutineProof(orcaPage, testInfo, 'routine-conversation-reply')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
