import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  launchGoldenStubAgentIntoChat
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePaneHookDescriptor
} from './helpers/terminal'

type TranscriptFaultProbe = { injectFailure: (sessionId: string) => string[] }
type FaultProbeGlobal = typeof globalThis & { chatTranscriptFaultProbe?: TranscriptFaultProbe }

for (const agent of ['claude', 'codex'] as const) {
  test.describe(agent, () => {
    test.use({ launchEnv: { ...getGoldenStubAgentLaunchEnv(), GOLDEN_STUB_TITLE_AGENT: agent } })

    test('keeps Chat, history, and a draft through title changes and retries a failed history stream', async ({
      orcaPage,
      electronApp
    }, testInfo) => {
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await ensureTerminalVisible(orcaPage)
      await configureGoldenStubAgent(orcaPage, { agent, chatView: true })
      const tabId = await launchGoldenStubAgentIntoChat(orcaPage, agent)
      const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
      const sessionId = randomUUID()
      const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-chat-reliability-'))
      const transcriptPath = path.join(scratch, 'conversation.jsonl')
      const answer = 'I recommend reviewing the registration flow.'
      const draft = 'Keep this important draft while reconnecting'
      const entries = [
        { role: 'user', text: 'Check registration for the team' },
        { role: 'assistant', text: answer }
      ]
      writeFileSync(
        transcriptPath,
        entries
          .map(({ role, text }, index) =>
            JSON.stringify(
              agent === 'claude'
                ? {
                    sessionId,
                    uuid: `turn-${index}`,
                    type: role,
                    timestamp: new Date(Date.now() + index * 100).toISOString(),
                    message: { role, content: [{ type: 'text', text }] }
                  }
                : {
                    type: 'event_msg',
                    timestamp: new Date(Date.now() + index * 100).toISOString(),
                    payload: {
                      type: role === 'user' ? 'user_message' : 'agent_message',
                      message: text
                    }
                  }
            )
          )
          .join('\n')
          .concat('\n')
      )
      try {
        await electronApp.evaluate(({ ipcMain }) => {
          const active = new Map<string, { sender: Electron.WebContents; sessionId: string }>()
          ipcMain.on('nativeChat:subscribe', (event, args) => {
            active.set(args.subscriptionId, { sender: event.sender, sessionId: args.sessionId })
          })
          ipcMain.on('nativeChat:unsubscribe', (_event, args) => {
            active.delete(args.subscriptionId)
          })
          // Reattachment replaces subscriptions; inject into the current one after title changes.
          ;(globalThis as FaultProbeGlobal).chatTranscriptFaultProbe = {
            injectFailure: (sessionId) => {
              const targets = [...active].filter(([, value]) => value.sessionId === sessionId)
              for (const [subscriptionId, { sender }] of targets) {
                sender.send('nativeChat:appended', {
                  subscriptionId,
                  frame: {
                    type: 'snapshot',
                    messages: [],
                    hasMore: false,
                    error: 'RELIABILITY_TRANSIENT_READ_FAILURE'
                  }
                })
              }
              return targets.map(([id]) => id)
            }
          }
        })
        await orcaPage.evaluate(
          ({ agent, descriptor, sessionId, transcriptPath }) => {
            window
              .__store!.getState()
              .setAgentStatus(
                descriptor.paneKey,
                { state: 'working', prompt: 'Check registration', agentType: agent },
                agent,
                undefined,
                { worktreeId: descriptor.worktreeId },
                { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
              )
          },
          { agent, descriptor, sessionId, transcriptPath }
        )
        const chat = orcaPage.locator('[data-native-chat-root="true"]').first()
        await expect(chat.getByText(answer, { exact: true })).toBeVisible()
        await chat.locator('textarea').fill(draft)
        const ptyId = await orcaPage.evaluate(
          (tabId) => window.__store!.getState().ptyIdsByTabId[tabId]![0],
          tabId
        )
        await sendToTerminal(orcaPage, ptyId, 'title-cycle\r')
        await expect
          .poll(() => getTerminalContent(orcaPage))
          .toContain('GOLDEN_STUB_TITLE_CHANGED_STILL_RUNNING')
        await expect(chat).toBeVisible()
        await expect(chat.locator('textarea')).toHaveValue(draft)
        const injected = await electronApp.evaluate(
          (_electron, sessionId) =>
            (globalThis as FaultProbeGlobal).chatTranscriptFaultProbe?.injectFailure(sessionId),
          sessionId
        )
        expect(
          injected?.length,
          'active transcript subscriptions received the fault'
        ).toBeGreaterThan(0)
        const notice = chat.locator('[data-native-chat-connection-notice]')
        await expect(notice).toBeVisible({ timeout: 15000 })
        await expect(chat.getByText(answer, { exact: true })).toBeVisible()
        await expect(notice.getByText('RELIABILITY_TRANSIENT_READ_FAILURE')).toBeHidden()
        await orcaPage.screenshot({ path: testInfo.outputPath('history-paused-draft-kept.png') })
        await notice.getByRole('button', { name: 'Retry', exact: true }).click()
        await expect(notice).toBeHidden()
        await expect(chat.getByText(answer, { exact: true })).toBeVisible()
        await expect(chat.locator('textarea')).toHaveValue(draft)
        const state = await orcaPage.evaluate((tabId) => {
          const s = window.__store!.getState()
          return {
            ptys: s.ptyIdsByTabId[tabId],
            mode: Object.values(s.unifiedTabsByWorktree)
              .flat()
              .find((tab) => tab.entityId === tabId)?.viewMode
          }
        }, tabId)
        expect(state).toEqual({ ptys: [ptyId], mode: 'chat' })
        for (const theme of ['light', 'dark'] as const) {
          await orcaPage.evaluate(async (theme) => {
            await window.__store!.getState().updateSettingsOrThrow({ theme })
          }, theme)
          await orcaPage.screenshot({ path: testInfo.outputPath(`recovered-${theme}.png`) })
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    })
  })
}
