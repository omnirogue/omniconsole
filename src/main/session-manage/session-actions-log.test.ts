import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  auditActor,
  SESSION_ACTIONS_FILE,
  SESSION_ACTIONS_ROTATE_BYTES,
  SessionActionsLog
} from './session-actions-log'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'session-actions-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const lines = () =>
  readFileSync(join(dir, SESSION_ACTIONS_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

describe('SessionActionsLog', () => {
  it('keeps an answered prompt, choice and provenance on a single JSON line', async () => {
    const log = new SessionActionsLog(dir)
    const ask = {
      kind: 'permission',
      text: 'Bash\npwd',
      options: [{ n: 1, label: 'Allow' }],
      fingerprint: 'a'.repeat(64)
    }
    await log.append({
      ...auditActor({ kind: 'pane', paneKey: 'manager:pane', title: 'Manager' }),
      action: 'answer',
      target: { paneKey: 'target:pane' },
      before: { ask },
      after: { chosen: { n: 1, label: 'Allow' }, delivery: 'confirmed' },
      summary: 'Answered the prompt',
      reason: 'Read-only inspection',
      request: 'Unblock the parser'
    })
    expect(lines()).toEqual([
      expect.objectContaining({
        actor: { paneKey: 'manager:pane', title: 'Manager' },
        action: 'answer',
        before: { ask },
        after: { chosen: { n: 1, label: 'Allow' }, delivery: 'confirmed' },
        reason: 'Read-only inspection',
        request: 'Unblock the parser'
      })
    ])
  })
  it('appends one JSON line per action with who, what, where and why', async () => {
    const log = new SessionActionsLog(dir, () => new Date('2026-09-24T12:00:00.000Z'))
    const error = await log.append({
      ...auditActor({ kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Manager' }),
      action: 'continue',
      target: { paneKey: 'tab-2:leaf-2', tabId: 'tab-2', title: 'Ads session' },
      before: { state: 'waiting-for-yes', keepGoing: true },
      after: { queued: '[from Manager] Go ahead', keepGoing: false },
      summary: 'Answered “Ads session” yes to its own proposal.',
      reason: 'Sal asked to unblock the ads session',
      request: 'tell the ads session to go ahead'
    })
    expect(error).toBeUndefined()
    await log.append({
      ...auditActor({ kind: 'cli' }),
      action: 'stop',
      target: { paneKey: 'p' },
      summary: 's'
    })
    expect(lines()).toEqual([
      {
        ts: '2026-09-24T12:00:00.000Z',
        actor: { paneKey: 'tab-9:leaf-9', title: 'Manager' },
        action: 'continue',
        target: { paneKey: 'tab-2:leaf-2', tabId: 'tab-2', title: 'Ads session' },
        before: { state: 'waiting-for-yes', keepGoing: true },
        after: { queued: '[from Manager] Go ahead', keepGoing: false },
        summary: 'Answered “Ads session” yes to its own proposal.',
        reason: 'Sal asked to unblock the ads session',
        request: 'tell the ads session to go ahead'
      },
      {
        ts: '2026-09-24T12:00:00.000Z',
        actor: 'cli',
        action: 'stop',
        target: { paneKey: 'p' },
        summary: 's'
      }
    ])
  })

  it('records an unproven pane claim beside, never as, the actor', () => {
    expect(auditActor({ kind: 'cli', unverifiedPaneKey: 'tab-5:leaf-5' })).toEqual({
      actor: 'cli',
      unverifiedPaneKey: 'tab-5:leaf-5'
    })
  })

  it('rotates to .1 once the file would pass its bound', async () => {
    const path = join(dir, SESSION_ACTIONS_FILE)
    writeFileSync(path, 'x'.repeat(SESSION_ACTIONS_ROTATE_BYTES - 10))
    const log = new SessionActionsLog(dir)
    await log.append({ actor: 'cli', action: 'rename', target: {}, summary: 'Renamed' })
    expect(statSync(`${path}.1`).size).toBe(SESSION_ACTIONS_ROTATE_BYTES - 10)
    expect(lines()).toHaveLength(1)
  })

  it('answers with a warning instead of throwing when the line cannot be written', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const blocked = join(dir, 'not-a-directory')
    writeFileSync(blocked, '')
    const log = new SessionActionsLog(blocked)
    await expect(
      log.append({ actor: 'cli', action: 'stop', target: {}, summary: 'Stopped' })
    ).resolves.toContain('the audit log could not be written')
    expect(logged).toHaveBeenCalledTimes(1)
    logged.mockRestore()
  })
})
