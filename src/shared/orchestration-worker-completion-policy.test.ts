import { describe, expect, it } from 'vitest'
import { readWorkerCompletionPolicy } from './orchestration-worker-completion-policy'

describe('worker completion opt-in', () => {
  it.each([
    '{}',
    'null',
    'invalid',
    '{"completionPolicy":true}',
    '{"completionPolicy":{"kind":"release_on_accepted_completion"}}'
  ])('keeps legacy, missing and malformed contracts manual: %s', (value) => {
    expect(readWorkerCompletionPolicy(value)).toBeNull()
  })
  it('reads the exact persisted launch contract', () => {
    const completionPolicy = {
      kind: 'release_on_accepted_completion',
      coordinator: { worktreeId: 'workspace', paneKey: 'pane' }
    }
    expect(readWorkerCompletionPolicy(JSON.stringify({ completionPolicy }))).toEqual(
      completionPolicy
    )
  })
})
