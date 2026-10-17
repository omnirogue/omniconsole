import { describe, expect, it } from 'vitest'

import { BOARD_TASK_ID_PATTERN, isBoardTaskId } from './board-task-id'
import { parseBackofficeTaskId } from './backoffice-task-link'
import { taskId } from './console-workflow-schemas'
import { HUB_TASK_ID_PATTERN } from './omnios-task-binding'

describe('the one board card id spelling', () => {
  it.each(['btk_AbC123', 'btk_0a1b', 'btk_abcdef0123456789'])('accepts %s everywhere', (id) => {
    expect(isBoardTaskId(id)).toBe(true)
    expect(taskId.safeParse(id).success).toBe(true)
    expect(HUB_TASK_ID_PATTERN.test(id)).toBe(true)
    expect(parseBackofficeTaskId(`omni://backoffice/task/${id}`)).toBe(id)
  })

  it.each(['btk_x', 'btk_ab-cd', 'btk_', `btk_${'a'.repeat(65)}`, 'hth_abcd1234', 42])(
    'refuses %s everywhere',
    (id) => {
      expect(isBoardTaskId(id)).toBe(false)
      expect(taskId.safeParse(id).success).toBe(false)
      expect(HUB_TASK_ID_PATTERN.test(String(id))).toBe(false)
      expect(parseBackofficeTaskId(`omni://backoffice/task/${String(id)}`)).toBeNull()
    }
  )

  it('is a single definition the transport routes and the zod schema share', () => {
    expect(HUB_TASK_ID_PATTERN).toBe(BOARD_TASK_ID_PATTERN)
  })
})
