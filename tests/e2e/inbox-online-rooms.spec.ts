import { test, expect } from './helpers/orca-app'
import { detail, roomEvent, ID } from '../../src/shared/room-test-fixtures'
import type { RoomSend, RoomSnapshot } from '../../src/shared/rooms'

test.use({ seedTestRepo: false })

test('Discussions opens shared human and agent Rooms, retries one event, and marks read explicitly', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const events = [
    roomEvent('1', { content: 'Human room message' }),
    roomEvent('2', {
      eventId: 'a0000000-0000-4000-8000-000000000002',
      senderId: ID,
      senderName: 'Research',
      senderKind: 'bot',
      content: 'Agent room answer'
    })
  ]
  await electronApp.evaluate(
    ({ ipcMain, BrowserWindow }, fixture) => {
      let consumed = '0'
      const attempts: { roomId: string; body: RoomSend }[] = []
      const acknowledgements: { roomId: string; sequence: string }[] = []
      let snapshot: RoomSnapshot = {
        events: fixture.events,
        sequence: '2',
        gaps: [],
        retryMs: 2000
      }
      const register = (name: string, fn: (...args: unknown[]) => unknown) => {
        ipcMain.removeHandler(name)
        ipcMain.handle(name, (_event, ...args) => fn(...args))
      }
      register('rooms:status', () => ({ ok: true, data: { state: 'linked' } }))
      register('rooms:listRooms', () => ({
        ok: true,
        data: { rooms: [fixture.detail], nextCursor: null }
      }))
      register('rooms:pendingSummary', () => ({
        ok: true,
        data: {
          rooms: [
            {
              roomId: fixture.detail.id,
              recipientId: fixture.detail.currentUserId,
              consumedSequence: consumed,
              headSequence: snapshot.sequence,
              pendingCount: Number(snapshot.sequence) - Number(consumed),
              mentionCount: 1
            }
          ],
          agents: [],
          nextCursor: null
        }
      }))
      register('rooms:getRoom', () => ({ ok: true, data: fixture.detail }))
      register('rooms:watch', (id) => ({ ok: true, data: id ? snapshot : null }))
      register('rooms:send', (roomId, input) => {
        const body = input as RoomSend
        attempts.push({ roomId: String(roomId), body })
        if (attempts.length === 1) {
          return { ok: false, error: { code: 'network_error' } }
        }
        snapshot = {
          ...snapshot,
          sequence: '3',
          events: [
            ...fixture.events,
            {
              ...fixture.events[0],
              ...body,
              sequence: '3',
              content: body.content
            }
          ]
        }
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('rooms:snapshot', { roomId, snapshot })
        }
        return { ok: true, data: { sequence: '3', replayed: true } }
      })
      register('rooms:ack', (roomId, sequence) => {
        consumed = String(sequence)
        acknowledgements.push({ roomId: String(roomId), sequence: consumed })
        return {
          ok: true,
          data: {
            roomId,
            recipientId: fixture.detail.currentUserId,
            consumedSequence: consumed,
            replayed: false
          }
        }
      })
      Object.assign(globalThis, { roomsParityObservations: { attempts, acknowledgements } })
    },
    { detail, events }
  )
  await orcaPage.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  const work = orcaPage.locator('[data-nav-group="work"]')
  if ((await work.getAttribute('aria-expanded')) !== 'true') {
    await work.click()
  }
  await orcaPage.getByRole('button', { name: /^Inbox(?:\s|$)/ }).click()
  const sections = orcaPage.getByRole('navigation', { name: 'Inbox sections' })
  await sections.getByRole('button', { name: /^Discussions(?:\s|$)/ }).click()
  await orcaPage.getByRole('button', { name: 'Online Rooms', exact: true }).last().click()
  const roomList = orcaPage.getByRole('navigation', { name: 'Your rooms' })
  await roomList.getByRole('button', { name: /Room.*2 unread/ }).click()
  await expect(orcaPage.getByText('Human room message', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('Agent room answer', { exact: true })).toBeVisible()
  const observations = () =>
    electronApp.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            roomsParityObservations: {
              attempts: { roomId: string; body: RoomSend }[]
              acknowledgements: { roomId: string; sequence: string }[]
            }
          }
        ).roomsParityObservations
    )
  expect((await observations()).acknowledgements).toEqual([])
  const composer = orcaPage.getByRole('textbox', { name: 'Room message' })
  await composer.fill('@Res')
  await orcaPage.getByRole('option', { name: /^@Research / }).click()
  await composer.press('End')
  await composer.pressSequentially('Please review this')
  await orcaPage.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(orcaPage.getByRole('alert')).toContainText('could not be reached')
  await expect(composer).not.toHaveValue('')
  await orcaPage.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(composer).toHaveValue('')
  const sent = (await observations()).attempts
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual(sent[0])
  expect(sent[0].roomId).toBe(ID)
  expect(sent[0].body.content).toBe('@Research Please review this')
  expect(sent[0].body.targetAgentIds).toEqual([ID])
  expect(sent[0].body.mentionedUserIds).toEqual([])
  expect(sent[0].body.eventId).toMatch(/^[a-f\d-]{36}$/)
  await orcaPage.getByRole('button', { name: 'Mark read', exact: true }).click()
  await expect(roomList.getByRole('button', { name: /Room.*0 unread/ })).toBeVisible()
  expect((await observations()).acknowledgements).toEqual([{ roomId: ID, sequence: '3' }])
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await cdp.send('Page.enable')
  await testInfo.attach('shared-human-agent-room.png', {
    body: Buffer.from((await cdp.send('Page.captureScreenshot')).data, 'base64'),
    contentType: 'image/png'
  })
  await cdp.detach()
  await sections.getByRole('button', { name: /^Handoff requests(?:\s|$)/ }).click()
  await expect(orcaPage.getByRole('textbox', { name: 'Room message' })).toHaveCount(0)
  await expect(sections.getByRole('button', { name: /^Handoff requests(?:\s|$)/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
})
