import { describe, expect, it } from 'vitest'
import { isJunkSessionTitle } from './session-junk-title'

describe('isJunkSessionTitle', () => {
  it.each([
    'worker-task_5ad8df40da3a',
    'worker-task-5ad8df40',
    'claude conversation',
    'Claude conversation',
    'codex session',
    'Claude Code chat',
    'gemini cli session',
    'ssh-20260925',
    'ssh-123456-host',
    '0f8fad5b-d9cb-469f-a165-70867728950e',
    '5ad8df40da3a',
    '  worker-task_5ad8df40da3a  '
  ])('flags %j', (title) => {
    expect(isJunkSessionTitle(title)).toBe(true)
  })

  it.each([
    null,
    undefined,
    '',
    '   ',
    'Fix the PDF export',
    'worker-task_notes',
    'worker-task_5ad8',
    'claude conversation about billing',
    'Review the SSH relay',
    'ssh-relay',
    'deadbeef',
    'Refer & Earn copy'
  ])('keeps %j', (title) => {
    expect(isJunkSessionTitle(title)).toBe(false)
  })
})
