import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cachedChoicesSidecars,
  choicesDecisionReceipt,
  choicesNotifySession,
  choicesSidecarPaths,
  findChoicesSidecar,
  parseChoicesSidecar
} from './choices-sidecar'

const SLUG = '1a1463cfb969aad9b'
const SESSION = '183553fc-03b2-4bfe-adea-b2962bc2d3d8'

/** The shape `choices` writes: Request changes (752) delivered, then Approve (758) read. */
const sidecarJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    slug: SLUG,
    cwd: '/Users/maintainer/omni-ide-worktrees/feat-1',
    notify: `mac-studio:${SESSION}`,
    notifyState: {
      address: `mac-studio:${SESSION}`,
      state: 'read',
      decision: 'changes_requested|752|1||',
      deliveredAt: '2026-10-16T23:17:10+00:00',
      sends: [{ ok: true, handed: true }],
      readKey: 'approved|758|2||',
      readAt: '2026-10-16T23:29:27+00:00'
    },
    ...overrides
  })

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'choices-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})
function put(day: string, name: string, body: string): string {
  mkdirSync(join(dir, day), { recursive: true })
  const path = join(dir, day, name)
  writeFileSync(path, body)
  return path
}

describe('choicesDecisionReceipt', () => {
  it('counts only a receipt for this exact decision id', () => {
    const sidecar = parseChoicesSidecar(sidecarJson(), SLUG)
    expect(choicesDecisionReceipt(sidecar, 758)).toContain('read decision 758')
    expect(choicesDecisionReceipt(sidecar, '752')).toContain('delivered decision 752')
    // A later decision on the same page is not proven by the earlier ones' receipts.
    expect(choicesDecisionReceipt(sidecar, 760)).toBeNull()
    expect(choicesDecisionReceipt(sidecar, undefined)).toBeNull()
    expect(choicesDecisionReceipt(sidecar, '')).toBeNull()
  })

  it('never takes a handed send, a state word or a reminder key for a delivery', () => {
    const pending = parseChoicesSidecar(
      sidecarJson({
        notifyState: {
          state: 'delivered',
          sends: [{ handed: true }],
          decision: 'pending||1|no_action|2026-10-16T23:50:53Z',
          deliveredAt: '2026-10-16T23:50:56+00:00'
        }
      }),
      SLUG
    )
    expect(choicesDecisionReceipt(pending, 758)).toBeNull()
    // A key without its time is not a receipt.
    const unstamped = parseChoicesSidecar(
      sidecarJson({ notifyState: { readKey: 'approved|758|2||' } }),
      SLUG
    )
    expect(choicesDecisionReceipt(unstamped, 758)).toBeNull()
  })
})

describe('findChoicesSidecar', () => {
  it('reads the page’s own sidecar first', async () => {
    const page = put('2026-10-01', '191227-plan.html', '<html/>')
    put('2026-10-01', '191227-plan.json', sidecarJson())
    const found = await findChoicesSidecar(SLUG, dir, page, {
      maxDays: 0,
      maxFiles: 0,
      maxBytes: 1 << 20
    })
    expect(found?.cwd).toBe('/Users/maintainer/omni-ide-worktrees/feat-1')
  })

  it('scans newest first within the day, file and size bounds', async () => {
    put('2026-10-14', '090000-old.json', sidecarJson())
    put('2026-10-16', '120000-other.json', JSON.stringify({ slug: 'other' }))
    put('2026-10-16', '110000-big.json', `${sidecarJson()}${' '.repeat(4096)}`)
    put('2026-10-16', 'notes.txt', SLUG)
    expect(await choicesSidecarPaths(dir, { maxDays: 1, maxFiles: 10, maxBytes: 1024 })).toEqual([
      join(dir, '2026-10-16', '120000-other.json'),
      join(dir, '2026-10-16', '110000-big.json')
    ])
    // The only match within one day is over the size cap; a second day finds the older one.
    expect(
      await findChoicesSidecar(SLUG, dir, undefined, { maxDays: 1, maxFiles: 10, maxBytes: 1024 })
    ).toBeNull()
    expect(
      (await findChoicesSidecar(SLUG, dir, undefined, { maxDays: 2, maxFiles: 10, maxBytes: 1024 }))
        ?.slug
    ).toBe(SLUG)
    // The file cap stops the scan before it reaches the older day.
    expect(
      await findChoicesSidecar(SLUG, dir, undefined, { maxDays: 2, maxFiles: 2, maxBytes: 1024 })
    ).toBeNull()
  })

  it('keeps a lookup for its time to live', async () => {
    let now = 0
    const lookup = cachedChoicesSidecars(dir, 1000, () => now)
    expect(await lookup(SLUG)).toBeNull()
    put('2026-10-16', '120000-plan.json', sidecarJson())
    expect(await lookup(SLUG)).toBeNull()
    now = 1000
    expect((await lookup(SLUG))?.slug).toBe(SLUG)
  })
})

describe('choicesNotifySession', () => {
  it('names the asking session and whether it is on this computer', () => {
    const sidecar = parseChoicesSidecar(sidecarJson(), SLUG)!
    expect(choicesNotifySession(sidecar, 'Mac-Studio.local')).toEqual({
      sessionId: SESSION,
      thisHost: true
    })
    expect(choicesNotifySession(sidecar, 'laptop')).toEqual({ sessionId: SESSION, thisHost: false })
    expect(choicesNotifySession({ ...sidecar, notify: SESSION }, 'laptop')?.thisHost).toBe(true)
    expect(choicesNotifySession({ ...sidecar, notify: 'mac-studio:../x' }, 'mac-studio')).toBeNull()
  })
})
