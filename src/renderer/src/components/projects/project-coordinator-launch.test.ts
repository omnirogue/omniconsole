import { describe, expect, it } from 'vitest'
import { coordinatorLaunchPick, coordinatorViewMode } from './project-coordinator-launch'

describe('coordinatorLaunchPick', () => {
  it('is the recorded pick with the Coordinator template unless one is recorded', () => {
    expect(
      coordinatorLaunchPick({ agent: 'claude', model: 'opus', effort: 'max', team: true })
    ).toEqual({
      agent: 'claude',
      model: 'opus',
      effort: 'max',
      team: true,
      templateId: 'coordinator'
    })
    expect(coordinatorLaunchPick({ agent: 'codex', templateId: 'planner' })).toEqual({
      agent: 'codex',
      team: false,
      templateId: 'planner'
    })
    expect(coordinatorLaunchPick({ agent: 'antigravity' })).toEqual({
      agent: 'antigravity',
      team: false,
      templateId: 'coordinator'
    })
  })

  it('is null for an agent the folder launcher does not start', () => {
    expect(coordinatorLaunchPick({ agent: 'opencode', model: 'ollama/llama3' })).toBeNull()
  })
})

it('opens the chat in the Chat view only where native chat is on', () => {
  expect(coordinatorViewMode(null)).toBe('chat')
  expect(coordinatorViewMode({ experimentalNativeChat: false })).toBe('terminal')
})
