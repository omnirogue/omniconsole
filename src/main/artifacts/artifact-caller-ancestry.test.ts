import { describe, expect, it } from 'vitest'
import { callerAncestry } from './artifact-caller-ancestry'
import { CLAUDE, CLI, ROWS, SELF, row } from './artifact-caller-ancestry-test-fixture'

const ancestry = (callerPid: number, agent = CLAUDE, rows = ROWS) =>
  callerAncestry(rows, callerPid, agent, SELF)

describe('callerAncestry', () => {
  it('puts a process the pane agent started under it (A2)', () => {
    expect(ancestry(220)).toBe('under')
  })

  it("puts the agent's own Python scripts under it (Homebrew and Xcode python3)", () => {
    expect(ancestry(250)).toBe('under')
    expect(ancestry(270)).toBe('under')
  })

  it("passes through OmniConsole's own CLI process, but not another app's", () => {
    expect(ancestry(290)).toBe('under')
    expect(callerAncestry(ROWS, 290, CLAUDE, '/usr/bin/other')).toBe('not-under')
  })

  it('puts a child of the pane outside its agent not under it (A1)', () => {
    expect(ancestry(410)).toBe('not-under')
    expect(ancestry(330)).toBe('not-under')
    expect(ancestry(900)).toBe('not-under')
  })

  it('puts an agent or app nested inside the pane agent not under it (A3)', () => {
    expect(ancestry(530)).toBe('not-under')
    expect(ancestry(630)).toBe('not-under')
    expect(ancestry(820)).toBe('not-under')
  })

  it("passes through the agent's own process under its launcher, with no hook report", () => {
    expect(ancestry(730, { pid: 700, agent: 'codex' })).toBe('under')
    expect(ancestry(730, { pid: 710, agent: 'codex' })).toBe('under')
    expect(ancestry(1030, { pid: 1000, agent: 'claude-agent-teams' })).toBe('under')
    expect(ancestry(1030, { pid: 1010, agent: 'claude' })).toBe('under')
    // A different agent under the wrapper is still nested.
    const codexUnderTeams = [...ROWS, row(1040, 1000, 'codex'), row(1050, 1040, CLI)]
    expect(ancestry(1050, { pid: 1000, agent: 'claude-agent-teams' }, codexUnderTeams)).toBe(
      'not-under'
    )
  })

  it('is unknown when the table does not name the caller, the agent or a parent', () => {
    expect(ancestry(999)).toBe('unknown')
    expect(ancestry(220, { pid: 999, agent: 'claude' })).toBe('unknown')
    expect(
      ancestry(
        220,
        CLAUDE,
        ROWS.filter((r) => r.pid !== 210)
      )
    ).toBe('unknown')
  })
})
