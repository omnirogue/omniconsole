import { describe, expect, it } from 'vitest'
import { taskContinuationInstruction } from './task-continuation-instruction'

const reviewer = { name: 'Reviewer', instructions: '# Reviewer' }

describe('taskContinuationInstruction', () => {
  it('sends the instruction unchanged for Default', () => {
    expect(taskContinuationInstruction('Finish the report.', null)).toEqual({
      instruction: 'Finish the report.',
      tooLong: false
    })
  })

  it('sends the instruction first and the template after it, in one message', () => {
    expect(taskContinuationInstruction('Finish the report.', reviewer).instruction).toBe(
      'Finish the report.\n\n---\n\nStanding instructions for this session (agent template "Reviewer"; follow them throughout):\n# Reviewer'
    )
  })

  it('flags a combined instruction over the 32,000 character limit', () => {
    expect(taskContinuationInstruction('x'.repeat(31_990), reviewer).tooLong).toBe(true)
    expect(taskContinuationInstruction('x'.repeat(31_990), null).tooLong).toBe(false)
  })
})
