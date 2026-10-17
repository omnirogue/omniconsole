import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ClosedSetupOutcomes,
  closeSetupTerminalOnSuccess,
  resolveWorktreeTerminalTidy,
  type SetupTerminalWatch
} from './worktree-terminal-tidy'

describe('resolveWorktreeTerminalTidy', () => {
  it("leaves a person's create exactly as it was", () => {
    expect(resolveWorktreeTerminalTidy({}, {})).toEqual({
      skipFallbackShell: false,
      closeSetupOnSuccess: false
    })
    expect(resolveWorktreeTerminalTidy({ openTerminal: true }, null)).toEqual({
      skipFallbackShell: false,
      closeSetupOnSuccess: false
    })
  })

  it("tidies an agent's create by default and opens the shell only when asked", () => {
    expect(resolveWorktreeTerminalTidy({ initiatedBy: 'agent' }, {})).toEqual({
      skipFallbackShell: true,
      closeSetupOnSuccess: true
    })
    expect(resolveWorktreeTerminalTidy({ initiatedBy: 'agent' }, undefined)).toEqual({
      skipFallbackShell: true,
      closeSetupOnSuccess: true
    })
    expect(resolveWorktreeTerminalTidy({ initiatedBy: 'agent', openTerminal: true }, {})).toEqual({
      skipFallbackShell: false,
      closeSetupOnSuccess: true
    })
  })

  it('is off for every create when the setting is explicitly false', () => {
    expect(
      resolveWorktreeTerminalTidy({ initiatedBy: 'agent' }, { tidyAgentWorktreeTerminals: false })
    ).toEqual({ skipFallbackShell: false, closeSetupOnSuccess: false })
  })
})

describe('closeSetupTerminalOnSuccess', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function fakeSetupTerminal(replay?: string) {
    const listeners = new Set<(data: string) => void>()
    const exitListeners = new Set<() => void>()
    const order: string[] = []
    const watch: SetupTerminalWatch = {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      replay: () => replay,
      onExit: (listener) => {
        exitListeners.add(listener)
        return () => exitListeners.delete(listener)
      },
      succeeded: vi.fn(() => order.push('succeeded')),
      close: vi.fn(async () => order.push('close'))
    }
    return {
      watch,
      order,
      emit: (data: string) => [...listeners].forEach((listener) => listener(data)),
      exit: () => [...exitListeners].forEach((listener) => listener()),
      watching: () => listeners.size + exitListeners.size
    }
  }

  it('closes the terminal on a later tick once setup reports exit 0', () => {
    const terminal = fakeSetupTerminal()
    closeSetupTerminalOnSuccess('token', terminal.watch)
    terminal.emit('installing\r\n__ORCA_SETUP_COMPLETE__:tok')
    terminal.emit('en:0\r\n$ ')
    expect(terminal.watch.succeeded).toHaveBeenCalledTimes(1)
    // Why a later tick: another observer of the same chunk still reads the marker first.
    expect(terminal.watch.close).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(terminal.order).toEqual(['succeeded', 'close'])
    expect(terminal.watching()).toBe(0)
  })

  it('keeps a failed setup open and stops watching', () => {
    const terminal = fakeSetupTerminal()
    closeSetupTerminalOnSuccess('token', terminal.watch)
    terminal.emit('error: missing env\r\n__ORCA_SETUP_COMPLETE__:token:1\r\n')
    vi.runAllTimers()
    expect(terminal.watch.succeeded).not.toHaveBeenCalled()
    expect(terminal.watch.close).not.toHaveBeenCalled()
    expect(terminal.watching()).toBe(0)
  })

  it('ignores another setup run and the echoed command line', () => {
    const terminal = fakeSetupTerminal()
    closeSetupTerminalOnSuccess('token', terminal.watch)
    terminal.emit('printf \'\\n__ORCA_SETUP_COMPLETE__:token:%s\\n\' "$status"\r\n')
    terminal.emit('__ORCA_SETUP_COMPLETE__:other:0\r\n')
    vi.runAllTimers()
    expect(terminal.watch.close).not.toHaveBeenCalled()
    expect(terminal.watching()).toBe(2)
  })

  it('reads a setup that finished before the watch began', () => {
    const terminal = fakeSetupTerminal('__ORCA_SETUP_COMPLETE__:token:0\r\n$ ')
    closeSetupTerminalOnSuccess('token', terminal.watch)
    vi.runAllTimers()
    expect(terminal.order).toEqual(['succeeded', 'close'])
  })

  it('stops watching when the terminal exits first, or when told to', () => {
    const exited = fakeSetupTerminal()
    closeSetupTerminalOnSuccess('token', exited.watch)
    exited.exit()
    exited.emit('__ORCA_SETUP_COMPLETE__:token:0\r\n')
    vi.runAllTimers()
    expect(exited.watch.close).not.toHaveBeenCalled()
    expect(exited.watching()).toBe(0)

    const stopped = fakeSetupTerminal()
    closeSetupTerminalOnSuccess('token', stopped.watch)()
    expect(stopped.watching()).toBe(0)
  })
})

describe('ClosedSetupOutcomes', () => {
  it('remembers a closed setup by handle, newest kept when full', () => {
    const outcomes = new ClosedSetupOutcomes()
    expect(outcomes.get('term_a')).toBeNull()
    outcomes.record('term_a', 0)
    expect(outcomes.get('term_a')).toEqual({ exitCode: 0 })
    for (let index = 0; index < 256; index += 1) {
      outcomes.record(`term_${index}`, 0)
    }
    expect(outcomes.get('term_a')).toBeNull()
    expect(outcomes.get('term_255')).toEqual({ exitCode: 0 })
    expect(outcomes.get('term_0')).toEqual({ exitCode: 0 })
  })
})
