import { test, expect } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  getGoldenStubStartupScreenEnv,
  launchGoldenStubAgentIntoChat
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.use({ launchEnv: getGoldenStubStartupScreenEnv('codex-update') })

for (const mode of ['send', 'identity-drift', 'stopped-agent', 'work'] as const) {
  const drift = mode === 'identity-drift'
  test(
    drift
      ? 'chat refuses account drift and keeps the chosen Uma tag'
      : mode === 'stopped-agent'
        ? 'chat sends to Uma after the AI has exited'
        : mode === 'work'
          ? 'Work sends a direct message without launching an AI'
          : 'chat tags Uma, sends a typed link, and opens its reply in place',
    async ({ electronApp, orcaPage }, testInfo) => {
      await electronApp.evaluate(({ ipcMain }, mismatch) => {
        const register = (name: string, result: unknown) => {
          ipcMain.removeHandler(name)
          ipcMain.handle(name, () => result)
        }
        const ok = (data: unknown) => ({ ok: true, data })
        register(
          'consoleCompanies:me',
          ok({
            ok: true,
            user: { employee_id: 'emp_sal_test', role: 'member' },
            company_scope: 'none',
            companies: []
          })
        )
        register('consoleCompanies:folders', ok({ ok: true, companies: [] }))
        register(
          'consoleHandoffs:recipients',
          ok({
            peopleSource: 'directory',
            employees: [
              { id: 'emp_sal_test', name: 'Sal Test', companies: [] },
              { id: 'emp_uma', name: 'Uma Evans', companies: [] }
            ]
          })
        )
        register('consoleHandoffs:agentRecipients', ok({ agents: [] }))
        register('backoffice:listTodo', {
          ok: true,
          baseUrl: 'https://fixture.test',
          employeeId: 'emp_sal_test',
          generatedAt: null,
          items: []
        })
        register('shell:pickAttachment', null)
        register(
          'consoleHandoffs:list',
          ok({ assignee: mismatch ? 'emp_sal' : 'emp_sal_test', threads: [] })
        )
        const detail = {
          thread: {
            id: 'hth_chat_test',
            board_task_id: null,
            author_employee_id: 'emp_sal_test',
            recipient_employee_id: 'emp_uma',
            title: 'Question for you',
            state: 'replied',
            action: null,
            communication_type: 'question',
            due_at: null,
            parent_thread_id: null,
            delivery_id: null,
            updated: new Date().toISOString()
          },
          entries: [
            {
              id: 'entry_1',
              kind: 'handoff',
              body: 'Question for you: https://drive.google.com/file/d/example/view',
              created: new Date().toISOString()
            },
            {
              id: 'entry_2',
              kind: 'reply',
              body: 'Yes, the plan is ready.',
              created: new Date().toISOString()
            }
          ],
          files: [],
          reviews: []
        }
        register('consoleHandoffs:get', ok(detail))
        register('consoleHandoffs:markRead', ok(detail))
        ipcMain.removeHandler('consoleHandoffs:sendCardless')
        ipcMain.handle('consoleHandoffs:sendCardless', (_event, input) => {
          if (
            mismatch ||
            input.recipient !== 'emp_uma' ||
            input.communicationType !== 'question' ||
            input.note !== detail.entries[0].body
          ) {
            return {
              ok: false,
              error: { code: 'wrong_recipient', message: 'The selected tag was not preserved.' }
            }
          }
          return ok({ thread_id: 'hth_chat_test' })
        })
      }, drift)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      if (mode === 'work') {
        await orcaPage.evaluate(() =>
          window.__store!.getState().openTaskPage({ taskSource: 'backoffice' })
        )
        await orcaPage.getByRole('button', { name: 'New message', exact: true }).click()
        const dialog = orcaPage.getByRole('dialog', { name: 'New message' })
        await dialog.getByRole('combobox', { name: 'To', exact: true }).click()
        await orcaPage.getByRole('option', { name: 'Uma Evans', exact: true }).click()
        await orcaPage.getByPlaceholder('Search teammates…').press('Escape')
        await dialog.getByRole('combobox', { name: 'Communication type' }).click()
        await orcaPage.getByRole('option', { name: 'Question', exact: true }).click()
        await dialog
          .getByRole('textbox', { name: 'Message', exact: true })
          .fill('Question for you: https://drive.google.com/file/d/example/view')
        await orcaPage.screenshot({ path: testInfo.outputPath('work-new-message.png') })
        await dialog.getByRole('button', { name: 'Send message', exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect(
          orcaPage.getByRole('button', { name: /^Waiting For/ }).first()
        ).toHaveAttribute('aria-pressed', 'true')
        return
      }
      await ensureTerminalVisible(orcaPage)
      await configureGoldenStubAgent(orcaPage, { chatView: true })
      await launchGoldenStubAgentIntoChat(orcaPage)
      const chat = orcaPage.locator('[data-native-chat-root="true"]').first()
      const composer = chat.locator('textarea').last()
      const startup = orcaPage.locator('[data-native-chat-startup-intervention="update-available"]')
      await expect(startup).toBeVisible({ timeout: 20_000 })
      if (mode === 'stopped-agent') {
        // The stub has no provider checkpoint; retain its unsent launch prompt as exit evidence.
        await orcaPage.evaluate(() => {
          const state = window.__store!.getState()
          const tab = state.tabsByWorktree[state.activeWorktreeId!]?.find(
            (entry) => entry.launchAgent === 'codex'
          )
          if (!tab) {
            throw new Error('The stub chat is missing.')
          }
          state.seedNativeChatLaunchPrompt({
            tabId: tab.id,
            agent: 'codex',
            text: 'Unsent AI prompt.',
            createdAt: Date.now()
          })
          state.markNativeChatLaunchPromptFailed(tab.id)
        })
      }
      await startup
        .getByRole('button', {
          name: mode === 'stopped-agent' ? /Update now/ : /Skip this time/
        })
        .click()
      if (mode !== 'stopped-agent') {
        await expect(composer).toBeEnabled({ timeout: 20_000 })
      }
      if (mode === 'send') {
        await composer.fill('@src/file.ts')
        await orcaPage.getByRole('option', { name: /Choose file/ }).click()
        await expect(composer).toHaveValue('@src/file.ts')
        await orcaPage.getByRole('option', { name: /File reference/ }).click()
        await expect(composer).toHaveValue('@src/file.ts ')
        await composer.fill('@NoMatchingEmployee')
        await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
        await composer.press('Enter')
        await expect(composer).toHaveValue('@NoMatchingEmployee')
      }
      if (mode === 'stopped-agent') {
        await expect(orcaPage.locator('[data-native-chat-agent-exited="true"]')).toBeVisible({
          timeout: 30_000
        })
        await expect(composer).toBeDisabled()
        await chat.getByRole('button', { name: 'Tag a person or agent', exact: true }).click()
        await expect(composer).toBeEnabled()
      }
      await composer.fill('@Um')
      await orcaPage.getByRole('option', { name: /Uma Evans/ }).click()
      const tags = chat.getByTestId('chat-delivery-bar')
      await expect(tags.getByText('@Uma Evans', { exact: true })).toBeVisible()
      await expect(composer).toHaveAttribute('placeholder', 'Send a message…')
      await expect(
        chat.getByRole('button', { name: 'Prompt Engineer', exact: true })
      ).toBeDisabled()
      await tags.getByRole('combobox', { name: 'Communication type' }).click()
      await orcaPage.getByRole('option', { name: 'Question', exact: true }).click()
      await composer.fill('Question for you: https://drive.google.com/file/d/example/view')
      await chat.getByRole('button', { name: 'Send message', exact: true }).click()
      if (drift) {
        await expect(chat.getByRole('alert')).toContainText('do not match')
        await expect(tags.getByText('@Uma Evans', { exact: true })).toBeVisible()
        await expect(composer).toHaveValue(
          'Question for you: https://drive.google.com/file/d/example/view'
        )
        await expect(chat.getByText('Sent to Uma Evans', { exact: true })).toHaveCount(0)
      } else {
        await expect(chat.getByText('Sent to Uma Evans', { exact: true }).last()).toBeVisible()
        await expect(composer).toHaveValue('')
        await chat.getByRole('button', { name: 'View message', exact: true }).last().click()
        await expect(chat.getByText('Yes, the plan is ready.', { exact: true })).toBeVisible()
        await expect(
          chat.getByRole('link', {
            name: 'https://drive.google.com/file/d/example/view',
            exact: true
          })
        ).toHaveAttribute('href', 'https://drive.google.com/file/d/example/view')
        await expect(chat.getByRole('button', { name: 'Give to AI', exact: true })).toHaveCount(0)
        await expect(chat.getByRole('button', { name: 'Reply', exact: true })).toBeVisible()
      }
      await orcaPage.screenshot({
        path: testInfo.outputPath(
          drift
            ? 'chat-refuses-identity-drift.png'
            : mode === 'stopped-agent'
              ? 'chat-person-message-after-ai-exit.png'
              : 'chat-uma-reply.png'
        ),
        animations: 'disabled'
      })
    }
  )
}
