import { describe, expect, it } from 'vitest'
import { COMMAND_SPECS } from './index'

const allNotes = COMMAND_SPECS.flatMap((spec) =>
  (spec.notes ?? []).map((note) => `${spec.path.join(' ')}: ${note}`)
)

// Why: the router resolves `--host runtime:` by name or id (execution-host-flag.ts), so a note
// demanding the id sends agents to scrape uuids the name already gives them.
describe('runtime host notes', () => {
  it('never says runtime: takes ids only', () => {
    expect(
      allNotes.filter((note) =>
        /not the environment name|matches ids only|runtime:<environment-id>/u.test(note)
      )
    ).toEqual([])
  })

  it('names both spellings on every routed project and automation command', () => {
    for (const path of [
      'project setups',
      'project setup-existing-folder',
      'project setup-clone',
      'project setup-create',
      'automations create',
      'worktree create'
    ]) {
      expect(allNotes.some((note) => note.startsWith(`${path}: --host runtime:<name|id>`))).toBe(
        true
      )
    }
  })
})
