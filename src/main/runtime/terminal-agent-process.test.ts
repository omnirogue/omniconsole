import { describe, expect, it, vi } from 'vitest'
import type { PosixReceiverRow } from '../pty/posix-pty-foreground-group'
import type { TerminalAgentProcessProof } from './terminal-agent-process'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import {
  agentProcessStillHolds,
  classifyTerminalProcessTree,
  findForegroundAgentProcess,
  proveCompletedCodexReporter
} from './terminal-agent-process'

const row = (pid: number, ppid: number, stat: string, command: string): ProcessTableRow => ({
  pid,
  ppid,
  stat,
  command
})

// The pane's shell is pid 100; laptop's real command lines, 2026-09-24.
const SHELL = row(100, 1, 'Ss', '-zsh')
const CLAUDE = row(200, 100, 'S+', '/Users/maintainer/.local/bin/claude --strict-mcp-config')
const CODEX_WRAPPER = row(300, 100, 'S+', 'node /Users/maintainer/.local/bin/codex resume 01a0')
const CODEX_NATIVE = row(
  301,
  300,
  'S+',
  '/Users/maintainer/.local/opt/node/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex'
)
const STUB = row(400, 100, 'S+', 'node /tmp/fixtures/golden-stub-agent/golden-stub-agent.js')
const ELSEWHERE = row(900, 1, 'S+', '/Users/maintainer/.local/bin/claude')
const WRAPPER_PROOF: TerminalAgentProcessProof = {
  ptyId: 'pty',
  incarnationId: 'inc',
  rootPid: 100,
  pid: 300,
  pgid: 300,
  startTimeMs: 1000,
  agent: 'codex',
  via: 'command-line'
}
const WRAPPER_RECEIVER: PosixReceiverRow = {
  tty: 'ttys001',
  pgid: 300,
  tpgid: 300,
  startTimeMs: 1000,
  stat: 'S+',
  command: CODEX_WRAPPER.command
}
const NATIVE_RECEIVER: PosixReceiverRow = {
  ...WRAPPER_RECEIVER,
  startTimeMs: 2000,
  command: CODEX_NATIVE.command
}
const COMPLETION = { pid: 301, completedAt: 3000, incarnation: 'pty:inc' }

function completedReporter(
  rows = [SHELL, CODEX_WRAPPER, CODEX_NATIVE],
  change: Partial<PosixReceiverRow> = {}
) {
  return proveCompletedCodexReporter(rows, WRAPPER_PROOF, WRAPPER_RECEIVER, COMPLETION, () => ({
    ...NATIVE_RECEIVER,
    ...change
  }))
}

describe('findForegroundAgentProcess', () => {
  it('finds a recognized agent holding this PTY’s foreground, by pid', () => {
    expect(findForegroundAgentProcess([SHELL, CLAUDE, ELSEWHERE], 100, null)).toEqual({
      pid: 200,
      agent: 'claude',
      via: 'command-line'
    })
    // A wrapper and its native child are one agent; the outer one lives as long as it does.
    expect(
      findForegroundAgentProcess([SHELL, CODEX_WRAPPER, CODEX_NATIVE], 100, null)
    ).toMatchObject({ pid: 300, agent: 'codex' })
  })

  it('never trusts an unrecognized process solely because a stale hook names its PID', () => {
    expect(findForegroundAgentProcess([SHELL, STUB], 100, 400)).toBeNull()
    const reused = row(200, 100, 'S+', 'vim notes.md')
    expect(findForegroundAgentProcess([SHELL, reused], 100, 200)).toBeNull()
    expect(findForegroundAgentProcess([SHELL, CLAUDE], 100, 200)).toMatchObject({
      agent: 'claude',
      via: 'hook-report'
    })
  })

  it('never proves an agent that is not in this PTY’s foreground', () => {
    const background = row(200, 100, 'S', CLAUDE.command)
    expect(findForegroundAgentProcess([SHELL, background], 100, 200)).toBeNull()
    // Another terminal's agent, and a shell at its own prompt.
    expect(findForegroundAgentProcess([row(100, 1, 'Ss+', '-zsh'), ELSEWHERE], 100, 900)).toBeNull()
    // A python the person started after the agent exited, with the old agent pid reported.
    const python = row(500, 100, 'S+', 'python3 manage.py shell')
    expect(findForegroundAgentProcess([SHELL, python], 100, 200)).toBeNull()
  })

  it('proves nothing while a job in the tree is stopped', () => {
    const stopped = row(200, 100, 'T', CLAUDE.command)
    expect(findForegroundAgentProcess([SHELL, stopped, STUB], 100, 400)).toBeNull()
  })

  it('finds an agent the shell exec’d, which is the PTY’s own root process', () => {
    // Managed launches exec the provider itself, so nothing sits under the root.
    const rootClaude = row(100, 1, 'Ss+', CLAUDE.command)
    expect(findForegroundAgentProcess([rootClaude, ELSEWHERE], 100, null)).toEqual({
      pid: 100,
      agent: 'claude',
      via: 'command-line'
    })
    expect(findForegroundAgentProcess([rootClaude], 100, 100)).toEqual({
      pid: 100,
      agent: 'claude',
      via: 'hook-report'
    })
    // An exec’d wrapper is still the outermost process of its agent, not its native child.
    const rootWrapper = row(100, 1, 'Ss+', CODEX_WRAPPER.command)
    const nativeChild = row(301, 100, 'S+', CODEX_NATIVE.command)
    expect(findForegroundAgentProcess([rootWrapper, nativeChild], 100, null)).toEqual({
      pid: 100,
      agent: 'codex',
      via: 'command-line'
    })
  })

  it('never proves a root process that is stopped, in the background, or not an agent', () => {
    expect(findForegroundAgentProcess([row(100, 1, 'Ss', CLAUDE.command)], 100, 100)).toBeNull()
    expect(findForegroundAgentProcess([row(100, 1, 'T', CLAUDE.command)], 100, 100)).toBeNull()
    expect(findForegroundAgentProcess([row(100, 1, 'Ss+', 'vim notes.md')], 100, 100)).toBeNull()
  })

  it('re-proves a persisted native reporter without replacing the ordinary wrapper proof', () => {
    expect(completedReporter()).toEqual({
      ...WRAPPER_PROOF,
      pid: 301,
      startTimeMs: 2000,
      via: 'hook-report'
    })
    expect(
      findForegroundAgentProcess([SHELL, CODEX_WRAPPER, CODEX_NATIVE], 100, null)
    ).toMatchObject({ pid: 300 })
  })

  it('rejects reused reporter PIDs, unknown births and a different foreground or tty', () => {
    expect(completedReporter(undefined, { startTimeMs: 4000 })).toBeNull()
    expect(completedReporter(undefined, { startTimeMs: 500 })).toBeNull()
    expect(completedReporter(undefined, { startTimeMs: null })).toBeNull()
    expect(completedReporter(undefined, { stat: 'S' })).toBeNull()
    expect(completedReporter(undefined, { stat: 'T+' })).toBeNull()
    expect(completedReporter(undefined, { tty: 'ttys002' })).toBeNull()
    expect(completedReporter(undefined, { pgid: 301, tpgid: 301 })).toBeNull()
    expect(completedReporter(undefined, { command: 'vim notes.md' })).toBeNull()
  })

  it('rejects absent, foreign, suspended or nested reporters without a native PID read', () => {
    const read = vi.fn(() => NATIVE_RECEIVER)
    const prove = (rows: (typeof SHELL)[]) =>
      proveCompletedCodexReporter(rows, WRAPPER_PROOF, WRAPPER_RECEIVER, COMPLETION, read)
    expect(prove([SHELL, CODEX_WRAPPER])).toBeNull()
    expect(prove([SHELL, CODEX_WRAPPER, { ...CODEX_NATIVE, ppid: 900 }])).toBeNull()
    expect(prove([SHELL, CODEX_WRAPPER, { ...CODEX_NATIVE, stat: 'S' }])).toBeNull()
    expect(prove([SHELL, { ...CODEX_WRAPPER, stat: 'T+' }, CODEX_NATIVE])).toBeNull()
    expect(
      prove([SHELL, CODEX_WRAPPER, row(302, 300, 'S+', 'bash'), { ...CODEX_NATIVE, ppid: 302 }])
    ).toBeNull()
    expect(prove([SHELL, { ...CODEX_WRAPPER, command: CLAUDE.command }, CODEX_NATIVE])).toBeNull()
    expect(prove([SHELL, CODEX_WRAPPER, CODEX_NATIVE, { ...CODEX_NATIVE, pid: 302 }])).toBeNull()
    expect(prove([SHELL, CODEX_WRAPPER, CODEX_NATIVE, { ...CLAUDE, ppid: 300 }])).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('agentProcessStillHolds', () => {
  const proof = { rootPid: 100, pid: 200, startTimeMs: 10_000 }

  it('holds while the same process, started at the same time, keeps the foreground', () => {
    expect(agentProcessStillHolds([SHELL, CLAUDE], proof, 10_500)).toBe(true)
  })

  it('fails once it left the foreground, exited, or its pid was reused', () => {
    expect(agentProcessStillHolds([SHELL, row(200, 100, 'S', CLAUDE.command)], proof, 10_000)).toBe(
      false
    )
    expect(agentProcessStillHolds([SHELL], proof, null)).toBe(false)
    // Same pid, a later start: another process.
    expect(agentProcessStillHolds([SHELL, CLAUDE], proof, 60_000)).toBe(false)
    expect(agentProcessStillHolds([SHELL, CLAUDE], proof, null)).toBe(false)
    // Re-parented out of this PTY's tree.
    expect(agentProcessStillHolds([SHELL, row(200, 1, 'S+', CLAUDE.command)], proof, 10_000)).toBe(
      false
    )
  })

  it('holds for an agent that is the PTY’s own root process, until it leaves the foreground', () => {
    const rootProof = { rootPid: 100, pid: 100, startTimeMs: 10_000 }
    const rootClaude = row(100, 1, 'Ss+', CLAUDE.command)
    expect(agentProcessStillHolds([rootClaude], rootProof, 10_500)).toBe(true)
    expect(agentProcessStillHolds([row(100, 1, 'Ss', CLAUDE.command)], rootProof, 10_000)).toBe(
      false
    )
    // Same pid, a later start: another process.
    expect(agentProcessStillHolds([rootClaude], rootProof, 60_000)).toBe(false)
  })
})

describe('classifyTerminalProcessTree (exit, from a table sampled now)', () => {
  it('does not infer an exit from a missing root or an exec replacement', () => {
    expect(classifyTerminalProcessTree([], 100, null)).toEqual({ kind: 'other' })
    expect(classifyTerminalProcessTree([row(100, 1, 'S', 'vim notes.md')], 100, null)).toEqual({
      kind: 'other'
    })
    expect(classifyTerminalProcessTree([CLAUDE], 100, null)).toEqual({ kind: 'other' })
    expect(classifyTerminalProcessTree([row(100, 1, 'S+', 'vim notes.md')], 100, null)).toEqual({
      kind: 'other'
    })
  })

  const classify = (rows: ProcessTableRow[], reporterPid: number | null = null) =>
    classifyTerminalProcessTree(rows, 100, reporterPid).kind

  it('reads the agent gone only when no agent is left and only shells hold the front', () => {
    // A shell must actually own the foreground; absence of an agent is not proof by itself.
    expect(classify([SHELL])).toBe('other')
    expect(classify([{ ...SHELL, stat: 'Ss+' }])).toBe('agent-gone')
    expect(classify([SHELL, row(150, 100, 'S+', '-bash')])).toBe('agent-gone')
    expect(classify([SHELL, row(150, 100, 'S+', '/bin/zsh -il')])).toBe('agent-gone')
  })

  it('never reads a stopped job as gone: a Ctrl-Z agent, or any stopped job', () => {
    expect(classify([SHELL, row(200, 100, 'T', CLAUDE.command)])).toBe('stopped')
    expect(classify([SHELL, row(500, 100, 'T', 'vim notes.md')])).toBe('stopped')
  })

  it('never reads gone while an agent is still in the tree, or another program is in front', () => {
    expect(classify([SHELL, CLAUDE])).toBe('other')
    expect(classify([SHELL, row(200, 100, 'S', CLAUDE.command)])).toBe('other')
    expect(classify([SHELL, STUB], 400)).toBe('other')
    expect(classify([SHELL, row(500, 100, 'S+', 'python3 manage.py shell')])).toBe('other')
    // The shell exec'd its agent, so the agent is the PTY's own process.
    expect(classify([row(100, 1, 'Ss+', CLAUDE.command)])).toBe('other')
  })
})
