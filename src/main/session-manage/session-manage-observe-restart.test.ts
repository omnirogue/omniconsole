/**
 * After a restart an idle agent posts no hook until it next acts, so a local pane's state comes
 * from what the host can read now: its last report (when it came from the agent process holding
 * the terminal now), its process and its screen. Only POSITIVE evidence reads idle; a quiet screen
 * or a report from an earlier process stays unknown. Claude, Codex and Grok each: idle, working,
 * back at the shell, and unprovable.
 */
import { describe, expect, it } from 'vitest'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { TerminalAgentEvidence } from '../runtime/terminal-agent-evidence'
import { toSessionManageEntry } from './session-manage-inventory'
import { observeSession, type SessionObserveSources } from './session-manage-observe'
import type { SessionLastHookReading } from './session-manage-pty-activity'
import { sessionDeleteRefusal } from './session-manage-delete-guard'
import { agentProcess, observeSources, sidebarRow } from './session-manage-test-fixtures'

type Title = 'working' | 'idle' | null
type Screen = NonNullable<TerminalAgentEvidence['screen']>

const screen = (over: Partial<Screen> = {}): Screen => ({
  blocked: null,
  working: false,
  turnDone: false,
  readyPrompt: false,
  ...over
})

/** The agent's own process in the foreground, proven by pid, started at t=10 000. */
function agentOnScreen(agent: string, over: Partial<Screen> | null = {}): TerminalAgentEvidence {
  return {
    foreground: { kind: 'agent', agent },
    process: agentProcess({ agent, startTimeMs: 10_000 }),
    tree: { kind: 'other' },
    screen: over === null ? null : screen(over)
  }
}

/** A process table read now: no agent left under the terminal's shell, stopped ones included. */
const atShell: TerminalAgentEvidence = {
  foreground: { kind: 'shell' },
  process: null,
  tree: { kind: 'agent-gone' },
  screen: screen()
}
const unreadable: TerminalAgentEvidence = {
  foreground: { kind: 'unavailable' },
  process: null,
  tree: null,
  screen: null
}

/** A pane after a restart: no fresh hook report, whatever else the host can read. */
function afterRestart(input: {
  title?: Title
  running?: boolean
  evidence: TerminalAgentEvidence | null
  lastHook?: SessionLastHookReading
}): SessionObserveSources {
  return observeSources({
    hook: () => null,
    lastHook: () => input.lastHook ?? null,
    agentStatus: async () => ({ running: input.running ?? true, status: input.title ?? null }),
    titleStatus: () => input.title ?? null,
    evidence: async () => input.evidence
  })
}

async function read(sources: SessionObserveSources, row: Partial<SessionManageSidebarRow> = {}) {
  return toSessionManageEntry(await observeSession(sidebarRow(row), sources))
}

/** A stored "done", by default sent by the agent process `agentOnScreen` proves (pid 200). */
const done = (
  at: number,
  agent: string,
  agentPid: number | null = 200
): SessionLastHookReading => ({
  state: 'done',
  interactivePrompt: null,
  updatedAt: at,
  agent,
  ...(agentPid !== null ? { agentPid } : {})
})

describe('a Claude pane after a restart', () => {
  it('is idle from its finished-turn line ("✻ Cogitated for 1s · done") under its own process', async () => {
    const entry = await read(
      afterRestart({ evidence: agentOnScreen('claude', { turnDone: true }) })
    )
    expect(entry).toMatchObject({ state: 'idle', stateBasis: 'screen', agentForeground: true })
  })

  it('is idle from its ✳ title when the screen shows no finished turn', async () => {
    const entry = await read(afterRestart({ title: 'idle', evidence: agentOnScreen('claude') }))
    expect(entry).toMatchObject({ state: 'idle', stateBasis: 'title', agentForeground: true })
  })

  it('is working while its title spins or its screen shows a turn in flight', async () => {
    const title = await read(afterRestart({ title: 'working', evidence: agentOnScreen('claude') }))
    expect(title).toMatchObject({ state: 'working', stateBasis: 'title' })
    const onScreen = await read(
      afterRestart({ evidence: agentOnScreen('claude', { working: true }) })
    )
    expect(onScreen).toMatchObject({ state: 'working', stateBasis: 'screen' })
  })

  it('never reads idle from a last report, whichever process sent it', async () => {
    const current = await read(
      afterRestart({ evidence: agentOnScreen('claude', null), lastHook: done(13_000, 'claude') })
    )
    expect(current).toMatchObject({ state: 'unknown', stateBasis: 'none', lastActivityAt: 13_000 })
    expect(current.waitingOn).toContain('cannot prove which process sent it')
    for (const agentPid of [111, null]) {
      const other = await read(
        afterRestart({
          evidence: agentOnScreen('claude', null),
          lastHook: done(13_000, 'claude', agentPid)
        })
      )
      expect(other).toMatchObject({ state: 'unknown', stateBasis: 'none' })
    }
  })

  it('is exited once the process table puts the shell back in the foreground', async () => {
    const entry = await read(afterRestart({ title: 'idle', evidence: atShell }))
    expect(entry).toMatchObject({ verdict: 'exited', state: 'exited', agentForeground: false })
  })

  it('stays unknown on a quiet screen, and on a report of work from before the restart', async () => {
    const quiet = await read(afterRestart({ evidence: agentOnScreen('claude') }))
    expect(quiet).toMatchObject({ state: 'unknown', agentForeground: true })
    const restoredWorking = await read(
      afterRestart({
        evidence: agentOnScreen('claude'),
        lastHook: { state: 'working', interactivePrompt: null, updatedAt: 9, restored: true }
      })
    )
    expect(restoredWorking).toMatchObject({ state: 'unknown', stateBasis: 'none' })
    expect(restoredWorking.waitingOn).toContain('before a restart')
  })
})

describe('a Codex pane after a restart (no title convention)', () => {
  const codex = { agent: 'codex' }

  it('is idle from "Worked for 8m 8s · done …" under its own process', async () => {
    const entry = await read(
      afterRestart({ evidence: agentOnScreen('codex', { turnDone: true }) }),
      codex
    )
    expect(entry).toMatchObject({ state: 'idle', stateBasis: 'screen', agentForeground: true })
  })

  it('is working while "• Working (1s • esc to interrupt)" is on its screen', async () => {
    const entry = await read(
      afterRestart({ evidence: agentOnScreen('codex', { working: true }) }),
      codex
    )
    expect(entry).toMatchObject({ state: 'working', stateBasis: 'screen' })
  })

  it('waits on the person while its update prompt holds the screen', async () => {
    const entry = await read(
      afterRestart({ evidence: agentOnScreen('codex', { blocked: 'codex-update-prompt' }) }),
      codex
    )
    expect(entry).toMatchObject({ state: 'awaiting-user', stateBasis: 'screen' })
    expect(entry.waitingOn).toContain('update prompt')
  })

  it('never reads idle from a last report, its own or another agent’s', async () => {
    const own = await read(
      afterRestart({ evidence: agentOnScreen('codex', null), lastHook: done(13_000, 'codex') }),
      codex
    )
    expect(own).toMatchObject({ state: 'unknown', stateBasis: 'none' })
    const foreign = await read(
      afterRestart({ evidence: agentOnScreen('codex', null), lastHook: done(13_000, 'claude') }),
      codex
    )
    expect(foreign.state).toBe('unknown')
  })

  it('is exited at the shell, and unknown on a quiet or unreadable screen', async () => {
    expect((await read(afterRestart({ evidence: atShell }), codex)).state).toBe('exited')
    expect((await read(afterRestart({ evidence: agentOnScreen('codex') }), codex)).state).toBe(
      'unknown'
    )
    const blind = await read(afterRestart({ evidence: unreadable }), codex)
    expect(blind).toMatchObject({ verdict: 'live', state: 'unknown', agentForeground: null })
  })
})

describe('a Grok pane after a restart', () => {
  const grok = { agent: 'grok' }

  it('reads idle and working from its "- grok" title, under its own process', async () => {
    expect(
      await read(afterRestart({ title: 'idle', evidence: agentOnScreen('grok') }), grok)
    ).toMatchObject({ state: 'idle', stateBasis: 'title', agentForeground: true })
    expect(
      await read(afterRestart({ title: 'working', evidence: agentOnScreen('grok') }), grok)
    ).toMatchObject({ state: 'working', stateBasis: 'title' })
  })

  it('never reads idle from its screen: its markers are not proven', async () => {
    const entry = await read(
      afterRestart({ evidence: agentOnScreen('grok', { turnDone: true }) }),
      grok
    )
    expect(entry.state).toBe('unknown')
  })

  it('is exited at the shell', async () => {
    expect((await read(afterRestart({ title: 'idle', evidence: atShell }), grok)).state).toBe(
      'exited'
    )
  })
})

describe('what the process evidence may prove', () => {
  it('requires owner evidence to exit an SSH pane, and never exits a launch still starting', async () => {
    const ssh = await read(afterRestart({ running: false, evidence: atShell }), {
      hostId: 'ssh:box'
    })
    expect(ssh).toMatchObject({ verdict: 'exited', state: 'exited' })
    const missing = await read(afterRestart({ running: false, evidence: unreadable }), {
      hostId: 'ssh:box'
    })
    expect(missing).toMatchObject({ verdict: 'unverifiable', state: 'unknown' })
    const starting = await read(afterRestart({ evidence: atShell }), { launchPending: true })
    expect(starting).toMatchObject({ verdict: 'live', state: 'unknown' })
  })

  it('needs the pid proof for agentForeground, and this row’s own agent', async () => {
    const named = await read(
      afterRestart({
        title: 'idle',
        evidence: {
          foreground: { kind: 'agent', agent: 'claude' },
          process: null,
          tree: { kind: 'other' },
          screen: null
        }
      })
    )
    expect(named).toMatchObject({ state: 'idle', agentForeground: null })
    const program = await read(
      afterRestart({
        title: 'idle',
        evidence: {
          foreground: { kind: 'program', process: 'python3' },
          process: null,
          tree: { kind: 'other' },
          screen: null
        }
      })
    )
    expect(program.agentForeground).toBe(false)
    // A Codex process now holds the pane of this Claude conversation.
    const replaced = await read(afterRestart({ title: 'idle', evidence: agentOnScreen('codex') }))
    expect(replaced.agentForeground).toBe(false)
    // An agent only its hook reports name (the process the pane's hooks give as agentPid).
    const vouched = await read(
      afterRestart({
        title: 'idle',
        evidence: {
          foreground: { kind: 'program', process: 'node' },
          process: agentProcess({ agent: null, via: 'hook-report' }),
          tree: { kind: 'other' },
          screen: null
        }
      })
    )
    expect(vouched.agentForeground).toBe(true)
  })
})

describe('a report never establishes idle (review 3 R4-1, review 4 R5-4)', () => {
  // The agent holding the terminal is pid 200, started at t=10 000; pid 111 ran before it.
  // Choice for R5-4: hooks do not report their sender's start time, so no report makes it idle.
  const report = (at: number, agentPid: number | null) =>
    observeSources({
      hook: () => ({
        state: 'done',
        interactivePrompt: null,
        updatedAt: at,
        ...(agentPid !== null ? { agentPid } : {})
      }),
      lastHook: () => done(at, 'claude', agentPid),
      agentStatus: async () => ({ running: true, status: null }),
      titleStatus: () => null,
      evidence: async () => agentOnScreen('claude')
    })

  it('reads the old pid’s done, delivered 2.5 s after the new agent started, as unknown', async () => {
    const entry = await read(report(12_500, 111))
    expect(entry).toMatchObject({ verdict: 'live', state: 'unknown', stateBasis: 'none' })
    expect(sessionDeleteRefusal(entry, { force: false })).toContain('cannot be verified')
    expect(sessionDeleteRefusal(entry, { force: true })).toContain('cannot be verified')
  })

  it('never counts a report that names no process', async () => {
    expect(await read(report(13_000, null))).toMatchObject({ state: 'unknown' })
  })

  it('reads working, never idle, while its screen or title shows work: any done, any pid', async () => {
    for (const agentPid of [111, 200, null]) {
      const onScreen = await read(
        observeSources({
          ...report(12_500, agentPid),
          evidence: async () => agentOnScreen('claude', { working: true })
        })
      )
      expect(onScreen).toMatchObject({ state: 'working', stateBasis: 'screen' })
      expect(sessionDeleteRefusal(onScreen, { force: false })).toContain('still working')
      const spinning = await read(
        observeSources({
          ...report(12_500, agentPid),
          agentStatus: async () => ({ running: true, status: 'working' }),
          titleStatus: () => 'working'
        })
      )
      expect(spinning).toMatchObject({ state: 'working', stateBasis: 'title' })
    }
  })

  it('refuses a delayed old report with the same pid (a reused pid): it is never idle', async () => {
    // Same pid as the agent now, received after it started: all a pid and arrival time can show.
    const entry = await read(report(13_000, 200))
    expect(entry).toMatchObject({ verdict: 'live', state: 'unknown', stateBasis: 'none' })
    expect(sessionDeleteRefusal(entry, { force: false })).toContain('cannot be verified')
  })

  it('still reads work and waiting from the current agent’s own report', async () => {
    const working = observeSources({
      ...report(13_000, 200),
      hook: () => ({ state: 'working', interactivePrompt: null, updatedAt: 14_000, agentPid: 200 })
    })
    expect(await read(working)).toMatchObject({ state: 'working', stateBasis: 'hook' })
    const asking = observeSources({
      ...report(13_000, 200),
      hook: () => ({
        state: 'done',
        interactivePrompt: 'Which branch?',
        updatedAt: 14_000,
        agentPid: 200
      })
    })
    expect(await read(asking)).toMatchObject({ state: 'awaiting-user', stateBasis: 'hook' })
  })
})

describe('exit needs a process table read now (review 2, M4)', () => {
  it('keeps an agent suspended with Ctrl-Z (stat T) live and unknown, never idle or exited', async () => {
    const suspended: TerminalAgentEvidence = { ...atShell, tree: { kind: 'stopped' } }
    const entry = await read(afterRestart({ running: false, evidence: suspended }), {
      shellForeground: true
    })
    expect(entry).toMatchObject({ verdict: 'live', state: 'unknown', agentForeground: false })
    expect(entry.waitingOn).toContain('suspended')
  })

  it('reads unavailable foreground evidence with a cached shell flag as unverifiable', async () => {
    const entry = await read(afterRestart({ running: false, evidence: unreadable }), {
      shellForeground: true
    })
    expect(entry).toMatchObject({ verdict: 'unverifiable', state: 'unknown' })
  })

  it('keeps a pane live while an agent is still in its tree behind the shell', async () => {
    const behind: TerminalAgentEvidence = { ...atShell, tree: { kind: 'other' } }
    const entry = await read(afterRestart({ running: false, evidence: behind }))
    expect(entry).toMatchObject({ verdict: 'live', state: 'unknown' })
  })
})
