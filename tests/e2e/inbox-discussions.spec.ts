import { test, expect } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('Inbox keeps handoffs separate and replies to the original discussion after checking messaging authority', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await electronApp.evaluate(({ ipcMain }) => {
    const mode = 'omniconsole'
    let sent: typeof message | null = null
    let reply: { id: string; summary: string; created_at: number } | null = null
    const message = {
      id: 'msg_isolated',
      project_id: 'proj_isolated',
      task_id: null,
      sender_session_id: 'pc_sender',
      recipient_session_id: 'pc_recipient',
      sender_employee_id: 'emp_sender',
      recipient_employee_id: 'emp_recipient',
      purpose: 'question',
      summary: 'Isolated discussion question',
      state: 'queued',
      created_at: 1,
      delivered_at: null,
      replied_at: null,
      resolved_at: null,
      expires_at: null,
      reply: null
    }
    const register = (name: string, fn: (...args: unknown[]) => unknown) => {
      ipcMain.removeHandler(name)
      ipcMain.handle(name, (_event, ...args) => fn(...args))
    }
    register('backoffice:listTodo', () => ({
      ok: true,
      baseUrl: 'https://fixture.test',
      employeeId: 'emp_recipient',
      generatedAt: null,
      items: [],
      awaitingVerification: [],
      nextCursor: null
    }))
    register('consoleHandoffs:recipients', () => ({ ok: true, data: { employees: [] } }))
    register('consoleHandoffs:list', () => ({
      ok: true,
      data: { assignee: 'emp_recipient', threads: [] }
    }))
    register('consoleWorkflows:listHumanActions', () => ({ ok: true, data: { jobs: [] } }))
    register('backoffice:feed', (input) => {
      const path = (input as { path: string }).path
      if (path === '/api/peer/people') {
        return {
          ok: true,
          body: { people: [{ employee_id: 'emp_sender', name: 'Colleague', enrolled: false }] }
        }
      }
      if (path === '/api/estate/peers/projects') {
        return { ok: true, body: { projects: [{ id: 'proj_isolated', name: 'Isolated project' }] } }
      }
      if (path.startsWith('/api/estate/peers/threads?')) {
        return {
          ok: true,
          body: {
            threads: [
              { ...message, state: reply ? 'replied' : 'queued', reply },
              ...(sent ? [sent] : [])
            ],
            next_cursor: null
          }
        }
      }
      return { ok: false, message: 'Fixture does not serve this read.' }
    })
    register('consoleWorkflows:readCommunicationMode', () => {
      const current = mode
      return {
        ok: true,
        data: {
          mode: current,
          ready: current === 'omniconsole',
          legacyWritesFenced: current !== 'legacy'
        }
      }
    })
    register('backoffice:inboxSend', (input) => {
      const request = input as { to: string; text: string; idempotencyKey: string }
      if (request.to !== 'emp_sender' || !request.idempotencyKey) {
        return { ok: false, message: 'Wrong person' }
      }
      sent = {
        ...message,
        id: 'msg_direct',
        summary: request.text,
        sender_employee_id: 'emp_recipient',
        recipient_employee_id: 'emp_sender'
      }
      return {
        ok: true,
        body: { recipient: { employee_id: request.to }, message: { id: sent.id, state: 'queued' } }
      }
    })
    register('consoleWorkflows:replyPeerMessage', (input) => {
      const request = input as { messageId: string; text: string; operationId: string }
      if (
        request.messageId !== message.id ||
        !request.operationId ||
        request.text !== 'Fixture answer'
      ) {
        return {
          ok: false,
          error: { code: 'wrong_target', message: 'Reply must retain the original message.' }
        }
      }
      reply = { id: 'reply_isolated', summary: request.text, created_at: 2 }
      return { ok: true, data: { id: reply.id, reply_to: message.id, state: 'queued' } }
    })
  })
  await orcaPage.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  const work = orcaPage.locator('[data-nav-group="work"]')
  await expect(work).toBeVisible()
  if ((await work.getAttribute('aria-expanded')) !== 'true') {
    await work.click()
  }
  await orcaPage.getByRole('button', { name: /^Inbox(?:\s|$)/ }).click()
  const sections = orcaPage.getByRole('navigation', { name: 'Inbox sections' })
  await expect(sections.getByRole('button', { name: /^Discussions(?:\s|$)/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  const row = orcaPage
    .locator('[data-work-row]')
    .filter({ hasText: 'Isolated discussion question' })
  await expect(row).toBeVisible()
  await orcaPage.getByRole('searchbox').fill('does not match')
  await expect(row).toHaveCount(0)
  await orcaPage.getByRole('searchbox').fill('')
  await row.click()
  await expect(
    orcaPage
      .locator('[data-work-message="msg_isolated"]')
      .getByText('Messaging moved to OmniRogue Chats. This earlier conversation remains readable.')
  ).toBeVisible()
  await expect(
    orcaPage.getByRole('button', { name: 'Reply to original message', exact: true })
  ).toHaveCount(0)
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await cdp.send('Page.enable')
  await testInfo.attach('inbox-migrated.png', {
    body: Buffer.from((await cdp.send('Page.captureScreenshot')).data, 'base64'),
    contentType: 'image/png'
  })
  await cdp.detach()
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('consoleWorkflows:readCommunicationMode')
    ipcMain.handle('consoleWorkflows:readCommunicationMode', () => ({
      ok: true,
      data: { mode: 'legacy', ready: false, legacyWritesFenced: false }
    }))
  })
  await orcaPage
    .locator('[data-work-message="msg_isolated"]')
    .getByRole('button', { name: 'Check again', exact: true })
    .click()
  await orcaPage
    .locator('[data-next-step-message="msg_isolated"]')
    .getByRole('textbox', { name: 'Note', exact: true })
    .fill('Fixture answer')
  await orcaPage.getByRole('button', { name: 'Reply to original message', exact: true }).click()
  await expect(
    orcaPage
      .locator('[data-work-message="msg_isolated"]')
      .getByText('Fixture answer', { exact: true })
  ).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Check again', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'New message', exact: true }).click()
  const compose = orcaPage.getByRole('dialog')
  await compose.getByRole('combobox').click()
  await orcaPage.getByRole('option', { name: /^Colleague(?: ·|$)/ }).click()
  await compose
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Direct message from the Inbox')
  await compose.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(compose).toHaveCount(0)
  await expect(
    orcaPage.locator('[data-work-row]').filter({ hasText: 'Direct message from the Inbox' })
  ).toBeVisible()
  await sections.getByRole('button', { name: 'Handoff requests', exact: true }).click()
  await expect(orcaPage.getByText('Isolated discussion question', { exact: true })).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('inbox-handoffs-separate.png') })
})
