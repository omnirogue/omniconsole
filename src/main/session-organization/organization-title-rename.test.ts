import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_FOLDERS_NO_WINDOW_ERROR } from '../../shared/session-folder-cli'
import type { OrganizationRelayedChange } from '../../shared/session-organization-change'
import { SESSION_ACTIONS_FILE, SessionActionsLog } from '../session-manage/session-actions-log'
import { OrganizationChangeLedger } from './organization-change-ledger'
import { OrganizationHistoryStore } from './organization-history-store'
import { recordTitleRename } from './organization-title-rename'

let dir: string
let seconds = 0
const now = () => new Date(Date.UTC(2026, 8, 25, 10, 0, (seconds += 1)))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'organization-title-'))
})

const opened: OrganizationChangeLedger[] = []

afterEach(async () => {
  // Why flush first: history.json is written asynchronously and would race the removal.
  await Promise.all(opened.splice(0).map((ledger) => ledger.flush()))
  rmSync(dir, { recursive: true, force: true })
})

function openLedger(): OrganizationChangeLedger {
  const store = new OrganizationHistoryStore({ directory: join(dir, 'session-organization') })
  store.load()
  const ledger = new OrganizationChangeLedger({
    trail: new SessionActionsLog(dir, now),
    store,
    now
  })
  opened.push(ledger)
  return ledger
}

function trail(): Record<string, unknown>[] {
  return readFileSync(join(dir, SESSION_ACTIONS_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

const ROW = { viewKey: 'claude:abc', paneKey: 'tab-1:leaf-1', tabId: 'tab-1', title: 'worker-1' }
const AGENT = { kind: 'pane' as const, paneKey: 'tab-9:leaf-9', title: 'Ads review' }

describe('recordTitleRename', () => {
  it('records a title an agent was told as yours: prepared first, applied with before and after', async () => {
    const ledger = openLedger()
    let relayed: OrganizationRelayedChange | undefined
    const result = await recordTitleRename(
      ledger,
      {
        row: ROW,
        title: ' Ads: Q4 headlines ',
        executor: AGENT,
        origin: 'yours',
        reason: 'the person named it',
        request: 'call it Ads: Q4 headlines'
      },
      async (change) => {
        relayed = change
        // The window answers with what it changed.
        expect(trail().map((line) => line.phase)).toEqual(['prepared'])
        return {
          summary: 'Renamed “worker-1” to “Ads: Q4 headlines”',
          before: 'worker-1',
          after: 'Ads: Q4 headlines',
          organization: {
            opId: change.opId,
            targets: [{ sessionKey: 'claude:abc', paneKey: 'tab-1:leaf-1', tabId: 'tab-1' }],
            value: 'Ads: Q4 headlines',
            before: ['worker-1'],
            after: ['Ads: Q4 headlines']
          }
        }
      }
    )
    expect(relayed).toMatchObject({
      executor: AGENT,
      origin: 'yours',
      reason: 'the person named it'
    })
    expect(result.opId).toBe(relayed?.opId)
    const lines = trail()
    expect(lines.map((line) => [line.phase, line.action, line.origin])).toEqual([
      ['prepared', 'rename', 'yours'],
      ['applied', 'rename', 'yours']
    ])
    expect(lines[1]).toMatchObject({
      actor: { paneKey: 'tab-9:leaf-9', title: 'Ads review' },
      reason: 'the person named it',
      request: 'call it Ads: Q4 headlines',
      summary: 'Renamed “worker-1” to “Ads: Q4 headlines”'
    })
    const history = await ledger.history('claude:abc')
    expect(history.entries).toHaveLength(1)
    expect(history.entries[0]).toMatchObject({
      kind: 'title',
      value: 'Ads: Q4 headlines',
      origin: 'yours',
      before: ['worker-1'],
      after: ['Ads: Q4 headlines'],
      revision: result.opId
    })
    expect(history.entries[0]!.revisionUnchecked).toBeUndefined()
    await ledger.flush()
  })

  it('defaults the origin to unknown and marks an older window’s rename unchecked', async () => {
    const ledger = openLedger()
    await recordTitleRename(
      ledger,
      { row: ROW, title: 'Parser fix', executor: { kind: 'cli' } },
      async () => ({
        summary: 'Renamed',
        before: 'worker-1',
        after: 'Parser fix'
      })
    )
    const [entry] = (await ledger.history('claude:abc')).entries
    expect(entry).toMatchObject({ origin: 'unknown', revisionUnchecked: true })
    await ledger.flush()
  })

  it('records failed no-window when no window could rename it, and rethrows', async () => {
    const ledger = openLedger()
    await expect(
      recordTitleRename(ledger, { row: ROW, title: 'X', executor: { kind: 'cli' } }, async () => {
        throw new Error(SESSION_FOLDERS_NO_WINDOW_ERROR)
      })
    ).rejects.toThrow(SESSION_FOLDERS_NO_WINDOW_ERROR)
    expect(
      trail().map((line) => [line.phase, (line.organization as { error?: string }).error])
    ).toEqual([
      ['prepared', undefined],
      ['failed', 'no-window']
    ])
    expect((await ledger.history('claude:abc')).entries).toEqual([])
    await ledger.flush()
  })
})
