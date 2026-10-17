import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WORKFLOW_CODEX_REFRESH_INTERVAL_MS } from './local-workflow-codex-launch'
import {
  WORKFLOW_FLEET_CODEX_LOGIN_SCRIPT,
  workflowFleetCodexLoginRefreshesWithin,
  workflowFleetCodexRefreshDue
} from './workflow-fleet-codex-login'
import { workflowFleetSsh } from './workflow-fleet-remote-shell'
import { createFakeFleet, fakeCodexLogin, type FakeFleet } from './workflow-fleet.test-fixtures'

const DAY = 24 * 60 * 60_000
const WITHIN = 50 * 60_000

describe('what a fleet host says about its Codex login', () => {
  const now = Date.parse('2026-10-10T12:00:00.000Z')

  it('is due at the access expiry or when the last refresh turns stale, whichever comes first', () => {
    const lastRefresh = new Date(now - DAY).toISOString()
    expect(
      workflowFleetCodexRefreshDue(
        JSON.stringify({ rotating: true, exp: (now + 10 * DAY) / 1000, last_refresh: lastRefresh })
      )
    ).toBe(now - DAY + WORKFLOW_CODEX_REFRESH_INTERVAL_MS)
    expect(
      workflowFleetCodexRefreshDue(
        JSON.stringify({ rotating: true, exp: (now + 60_000) / 1000, last_refresh: lastRefresh })
      )
    ).toBe(now + 60_000)
  })

  it('has nothing to refresh without a rotating login, and cannot tell from anything else', () => {
    expect(workflowFleetCodexRefreshDue('{"rotating":false}')).toBeNull()
    for (const said of ['', '{}', 'null', 'perl: not found', '{"rotating":"yes"}']) {
      expect(workflowFleetCodexRefreshDue(said)).toBeUndefined()
    }
    expect(
      workflowFleetCodexRefreshDue('{"rotating":true,"exp":null,"last_refresh":"2026-10-10"}')
    ).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('reading a fleet host Codex login', () => {
  let fleet: FakeFleet
  let login: string
  beforeEach(async () => {
    fleet = await createFakeFleet(['mw0004'])
    login = join(fleet.host('mw0004').home, '.codex', 'auth.json')
  })
  afterEach(() => fleet.close())

  it('shares the login only while it outlasts the call, and never when unsure', async () => {
    const current = Date.now()
    const refreshes = () => workflowFleetCodexLoginRefreshesWithin('mw0004', WITHIN)
    await writeFile(login, fakeCodexLogin(current + 10 * DAY))
    await expect(refreshes()).resolves.toBe(false)
    await writeFile(login, fakeCodexLogin(current + 30 * 60_000))
    await expect(refreshes()).resolves.toBe(true)
    await writeFile(login, fakeCodexLogin(current + 10 * DAY, new Date(current - 9 * DAY)))
    await expect(refreshes()).resolves.toBe(true)
    await writeFile(login, JSON.stringify({ OPENAI_API_KEY: 'fixture-key' }))
    await expect(refreshes()).resolves.toBe(false)
    await writeFile(login, 'not json')
    await expect(refreshes()).resolves.toBe(true)
    await rm(login)
    await expect(refreshes()).resolves.toBe(true)
    await writeFile(login, fakeCodexLogin(current + 10 * DAY))
    await writeFile(join(fleet.host('mw0004').state, 'lost'), '')
    await expect(refreshes()).resolves.toBe(true)
  })

  it('brings only the times home, never a token', async () => {
    const expiresAt = Date.now() + 10 * DAY
    await writeFile(login, fakeCodexLogin(expiresAt, '2026-10-10T12:00:00.123456Z'))
    const read = await workflowFleetSsh({}, 'mw0004', WORKFLOW_FLEET_CODEX_LOGIN_SCRIPT, 10_000)
    expect(read?.code).toBe(0)
    expect(JSON.parse(read!.stdout)).toEqual({
      rotating: true,
      exp: Math.floor(expiresAt / 1000),
      last_refresh: '2026-10-10T12:00:00.123456Z'
    })
    expect(read!.stdout).not.toContain('fixture-refresh')
    expect(read!.stdout).not.toContain('header')
  })
})
