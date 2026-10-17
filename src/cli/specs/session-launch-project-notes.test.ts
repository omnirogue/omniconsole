import { describe, expect, it } from 'vitest'
import { COMMAND_SPECS } from './index'

function notesOf(path: string): string {
  const spec = COMMAND_SPECS.find((entry) => entry.path.join(' ') === path)
  return (spec?.notes ?? []).join('\n')
}

// Why: --project always creates a fresh default-base worktree whose setup runs beside the agent and
// refuses --worktree, so help that only says "picks the computer" sends feature-branch work to main.
describe('session launch --project notes', () => {
  it('says the --project worktree starts from the repo default base without local work', () => {
    const notes = notesOf('session launch')
    expect(notes).toContain('A git project gets a fresh worktree there from the repo default base')
    expect(notes).toContain('Its setup script runs beside the agent (like --setup run)')
    expect(notes).toContain('wait-for-setup is refused (launch_setup_first, nothing sent)')
    expect(notes).not.toContain('without setup hooks')
    expect(notes).toContain('your branch and uncommitted or unpushed work do not travel')
  })

  it('tells find-owner callers to drop --project or replace it with --worktree', () => {
    expect(notesOf('session find-owner')).toContain(
      'that launch starts in a fresh worktree from the repo default base, so drop --project to stay on your branch, or replace it with --worktree for a checkout you made (the two are refused together).'
    )
  })
})
