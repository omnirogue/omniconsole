// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActionContext } from '../ToolRegistry'
import { ToolRegistry } from '../ToolRegistry'
import { useCoreStore } from '../../../integration/store/coreStore'
import { useUiStore } from '../../../integration/store/uiStore'

function agent(humanInTheLoop: boolean): AgentActionContext {
  return {
    data: { index: 2, name: 'Writer', humanInTheLoop },
    setState: vi.fn(),
    appendHistory: vi.fn()
  }
}

beforeEach(() => {
  useCoreStore.setState(useCoreStore.getInitialState(), true)
  useUiStore.setState(useUiStore.getInitialState(), true)
})

describe.each(['sess:ses_customer', 'worktree:customer'])('projected tool call %s', (taskId) => {
  it.each([true, false])(
    'refuses completion without claims, with humanInTheLoop=%s',
    (humanInTheLoop) => {
      const context = agent(humanInTheLoop)
      const before = useCoreStore.getState()
      expect(
        ToolRegistry.process(context, {
          name: 'complete_task',
          args: { taskId, output: 'A locally written result' }
        })
      ).toBe(false)
      expect(useCoreStore.getState()).toBe(before)
      expect(context.setState).not.toHaveBeenCalled()
      expect(context.appendHistory).not.toHaveBeenCalled()
    }
  )
})

it('preserves completion and its log for local ad hoc tasks', () => {
  const task = useCoreStore.getState().addTask({
    title: 'Draft ideas',
    description: '',
    assignedAgentId: 2,
    status: 'in_progress',
    requiresUserApproval: false
  })
  expect(
    ToolRegistry.process(agent(false), {
      name: 'complete_task',
      args: { taskId: task.id, output: 'Three ideas' }
    })
  ).toBe(true)
  expect(useCoreStore.getState().tasks[0]).toMatchObject({ status: 'done', output: 'Three ideas' })
  expect(useCoreStore.getState().actionLog).toEqual([
    expect.objectContaining({ action: 'completed task', taskId: task.id })
  ])
})
