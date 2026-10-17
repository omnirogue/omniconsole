import { describe, expect, it } from 'vitest'
import { localWorkflowFindSpec } from '../../../../shared/local-workflow-find-request'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { poolFromGivenItems } from './graph-find-pool'

describe('Scan pool compatibility', () => {
  it('preserves the pre-Scan string pool exactly, including whitespace', () => {
    expect(poolFromGivenItems([' A ', 'B'])).toEqual([
      { key: 'list.1', title: ' A ', detail: '', seatId: 'your-list', by: 'your list' },
      { key: 'list.2', title: 'B', detail: '', seatId: 'your-list', by: 'your list' }
    ])
    const spec = localWorkflowFindSpec({ prompt: 'Best', items: [' A ', 'B', 'a'] }, ['codex'], [])
    expect(normalizeWorkflowSpec(spec).find?.items).toEqual(['A', 'B'])
  })
  it('keeps a structured entry as a plain title (find.items stays string[]), and its detail alongside', () => {
    const items = [{ title: 'a/b', detail: 'Detail', url: 'https://github.com/a/b' }, 'Other']
    const spec = localWorkflowFindSpec({ prompt: 'Best', items }, ['codex'], [])
    const normalized = normalizeWorkflowSpec(spec).find
    // An older build that has never heard of itemDetails still reads correct titles.
    expect(normalized?.items).toEqual(['a/b', 'Other'])
    expect(normalized?.itemDetails).toEqual([
      { detail: 'Detail', url: 'https://github.com/a/b' },
      {}
    ])
  })
})
