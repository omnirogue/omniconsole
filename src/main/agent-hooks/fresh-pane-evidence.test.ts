import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshPanes, hookEvent, startRow } from './fresh-pane-evidence-test-fixtures'
import { isBlankFreshStart, isUntouchedFreshStart } from './fresh-session-start'

const PANE = 'tab-1:leaf-1'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fresh-panes-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('FreshPaneEvidence', () => {
  it('reads untouched after a fresh start and nothing since', () => {
    const f = freshPanes()
    f.hook(hookEvent())
    expect(f.evidence.read(PANE, 's1')).toBe('untouched')
    // A repeated start of the same session, or its id arriving alone, is not a prompt.
    f.hook(hookEvent())
    f.hook(hookEvent({ providerSessionOnly: true, hookEventName: 'session_start' }))
    expect(f.evidence.read(PANE, 's1')).toBe('untouched')
  })

  it('reads touched after a prompt, any other event, typed input or a turn', () => {
    const cases: ((f: ReturnType<typeof freshPanes>) => void)[] = [
      (f) => f.hook(hookEvent({ hookEventName: 'UserPromptSubmit', prompt: 'fix it' })),
      (f) => f.hook(hookEvent({ hookEventName: 'Stop' })),
      (f) => f.hook(hookEvent({ sessionStartSource: 'clear' })),
      (f) => f.hook(hookEvent({ providerSession: { key: 'claude', id: 's2' } as never })),
      (f) => f.write(PANE),
      (f) => f.write(PANE, 'turn')
    ]
    for (const touch of cases) {
      const f = freshPanes()
      f.hook(hookEvent())
      touch(f)
      expect(f.evidence.read(PANE, 's1')).toBe('touched')
    }
  })

  it('ignores hook-report fence revocations and input to other panes', () => {
    const f = freshPanes()
    f.hook(hookEvent())
    f.write(PANE, 'hook')
    f.write('tab-2:leaf-1')
    expect(f.evidence.read(PANE, 's1')).toBe('untouched')
  })

  it('reads unknown with no fresh start, a resumed start, a gap, a spooled event or another session', () => {
    expect(freshPanes().evidence.read(PANE, 's1')).toBe('unknown')

    const resumed = freshPanes()
    resumed.hook(hookEvent({ sessionStartSource: 'resume' }))
    expect(resumed.evidence.read(PANE, 's1')).toBe('touched')

    const restarted = freshPanes()
    restarted.hook(hookEvent())
    restarted.clock.epoch += 1
    expect(restarted.evidence.read(PANE, 's1')).toBe('unknown')

    const spooled = freshPanes()
    spooled.hook(hookEvent())
    spooled.clock.spooled = true
    expect(spooled.evidence.read(PANE, 's1')).toBe('unknown')

    const other = freshPanes()
    other.hook(hookEvent())
    expect(other.evidence.read(PANE, 's9')).toBe('unknown')
    expect(other.evidence.read(PANE, null)).toBe('unknown')
  })

  it('never lets a later fresh start clear an earlier touch, and ignores remote events', () => {
    const f = freshPanes()
    f.hook(hookEvent({ hookEventName: 'UserPromptSubmit', prompt: 'hi' }))
    f.hook(hookEvent())
    expect(f.evidence.read(PANE, 's1')).toBe('touched')

    const remote = freshPanes()
    remote.hook(hookEvent({ connectionId: 'ssh-1' }))
    expect(remote.evidence.read(PANE, 's1')).toBe('unknown')
  })

  it('forgets everything once disposed', () => {
    const f = freshPanes()
    f.hook(hookEvent())
    f.evidence.dispose()
    f.hook(hookEvent())
    expect(f.evidence.read(PANE, 's1')).toBe('unknown')
  })
})

describe('FreshPaneEvidence across app runs', () => {
  const restart = (store: string, rows = [startRow()], now = 5_000) =>
    freshPanes({ now, store, rows })

  it('carries an untouched start over a restart, and needs no spooled event since', () => {
    const store = join(dir, 'fresh-panes.json')
    const first = freshPanes({ store })
    first.hook(hookEvent({ agentPid: 4242 }))
    first.evidence.dispose()

    const second = restart(store)
    expect(second.evidence.read(PANE, 's1')).toBe('untouched')
    expect(second.evidence.start(PANE)).toMatchObject({
      agentPid: 4242,
      agent: 'claude',
      restored: true,
      legacy: false
    })
    second.clock.drained = true
    expect(second.evidence.read(PANE, 's1')).toBe('unknown')
    second.evidence.dispose()
    // A start whose pane the spool drained at this run's start was reached while the app was down.
    expect(freshPanes({ now: 6_000, store, drained: true }).evidence.read(PANE, 's1')).toBe(
      'touched'
    )
    expect(restart(store).evidence.read(PANE, 's1')).toBe('touched')
  })

  it('refreshes its start when the same session announces itself again', () => {
    const store = join(dir, 'fresh-panes.json')
    const f = freshPanes({ store })
    f.hook(hookEvent())
    f.clock.now = 3_000
    f.hook(hookEvent())
    expect(f.evidence.start(PANE)).toMatchObject({ startedAt: 3_000 })
    expect(f.evidence.read(PANE, 's1')).toBe('untouched')
  })

  it('never forgets a keystroke or a lost hook POST across a restart', () => {
    const store = join(dir, 'fresh-panes.json')
    const typed = freshPanes({ store })
    typed.hook(hookEvent())
    typed.write(PANE)
    typed.evidence.dispose()
    expect(restart(store).evidence.read(PANE, 's1')).toBe('touched')

    const lostStore = join(dir, 'lost.json')
    const lost = freshPanes({ store: lostStore })
    lost.hook(hookEvent())
    lost.lose()
    lost.evidence.dispose()
    expect(restart(lostStore).evidence.read(PANE, 's1')).toBe('touched')
  })

  it('seeds a Claude start older than the evidence file, and nothing newer or used', () => {
    const store = join(dir, 'fresh-panes.json')
    const f = freshPanes({
      store,
      now: 1_000,
      rows: [
        startRow(),
        startRow({ paneKey: 'tab-2:leaf-1', receivedAt: 2_000 }),
        startRow({ paneKey: 'tab-3:leaf-1', prompt: 'fix it' }),
        startRow({ paneKey: 'tab-4:leaf-1', agentType: 'gemini' })
      ]
    })
    expect(f.evidence.start(PANE)).toMatchObject({ legacy: true, restored: true })
    for (const pane of ['tab-2:leaf-1', 'tab-3:leaf-1', 'tab-4:leaf-1']) {
      expect(f.evidence.start(pane)).toBeNull()
    }
    f.evidence.dispose()
    // A later run keeps the seed, and seeds only starts older than the file, never newer ones.
    const later = restart(
      store,
      [
        startRow({ paneKey: 'tab-5:leaf-1', receivedAt: 900 }),
        startRow({ paneKey: 'tab-6:leaf-1', receivedAt: 3_000 })
      ],
      9_000
    )
    expect(later.evidence.start(PANE)).toMatchObject({ legacy: true })
    expect(later.evidence.start('tab-5:leaf-1')).toMatchObject({ legacy: true })
    expect(later.evidence.start('tab-6:leaf-1')).toBeNull()
  })

  it('trusts no pane from a damaged evidence file', () => {
    const store = join(dir, 'fresh-panes.json')
    writeFileSync(store, '{"version":1,"createdAt":')
    const f = freshPanes({ store, rows: [startRow()] })
    expect(f.evidence.read(PANE, 's1')).toBe('unknown')
    expect(readFileSync(store, 'utf8')).toBe('{"version":1,"createdAt":')
  })
})

describe('which fresh starts read as blank', () => {
  it('takes Claude, Codex and Gemini startups and OpenCode root starts, never a resume', () => {
    expect(isBlankFreshStart(hookEvent({ source: 'claude' }))).toBe(true)
    expect(isBlankFreshStart(hookEvent({ source: 'codex' }))).toBe(true)
    expect(isBlankFreshStart(hookEvent({ source: 'gemini' }))).toBe(true)
    expect(isBlankFreshStart(hookEvent({ source: 'gemini', sessionStartSource: 'resume' }))).toBe(
      false
    )
    const opencode = hookEvent({ source: 'opencode', sessionStartSource: undefined })
    expect(isBlankFreshStart(opencode)).toBe(true)
    expect(isBlankFreshStart(hookEvent({ source: 'kimi', sessionStartSource: undefined }))).toBe(
      false
    )
    expect(isBlankFreshStart(hookEvent({ source: 'grok', hookEventName: 'session_start' }))).toBe(
      false
    )
    // The transfer watcher's own proof stays Claude and Codex only.
    expect(isUntouchedFreshStart(hookEvent({ source: 'gemini' }))).toBe(false)
    expect(isUntouchedFreshStart(hookEvent({ source: 'codex' }))).toBe(true)
  })
})

describe('FreshPaneEvidence on SSH panes', () => {
  const ssh = (overrides = {}) =>
    hookEvent({ connectionId: 'devbox', launchToken: 'l1', ...overrides })

  it('reads a live SSH start untouched only within its connection, and never keeps it', () => {
    const store = join(dir, 'fresh-panes.json')
    const f = freshPanes({ store, ssh: true })
    f.hook(ssh())
    expect(f.evidence.read(PANE, 's1')).toBe('untouched')
    expect(f.evidence.start(PANE)).toMatchObject({ connectionId: 'devbox', launchToken: 'l1' })
    f.clock.connections.devbox = 1
    expect(f.evidence.read(PANE, 's1')).toBe('unknown')
    f.evidence.dispose()
    expect(freshPanes({ store, ssh: true }).evidence.read(PANE, 's1')).toBe('unknown')
  })

  it('reads touched after a keystroke, a prompt or a replay on reconnect', () => {
    const cases: ((f: ReturnType<typeof freshPanes>) => void)[] = [
      (f) => f.write(PANE),
      (f) => f.hook(ssh({ hookEventName: 'UserPromptSubmit', prompt: 'fix it' })),
      (f) => f.hook(ssh({ isReplay: true }))
    ]
    for (const touch of cases) {
      const f = freshPanes({ ssh: true })
      f.hook(ssh())
      touch(f)
      expect(f.evidence.read(PANE, 's1')).toBe('touched')
    }
    // A pane first heard from on another connection than its record is never read untouched.
    const moved = freshPanes({ ssh: true })
    moved.hook(ssh())
    moved.hook(ssh({ connectionId: 'otherbox' }))
    expect(moved.evidence.read(PANE, 's1')).toBe('touched')
  })
})
