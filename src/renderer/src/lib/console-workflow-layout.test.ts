import { describe, expect, it } from 'vitest'
import { layoutConsoleWorkflow } from './console-workflow-layout'

describe('server workflow presentation layers', () => {
  it('keeps joins after every predecessor, independent of response order', () => {
    const nodes = [
      { key: 'release', after: ['review-a', 'review-b'] },
      { key: 'review-b', after: ['build'] },
      { key: 'build' },
      { key: 'review-a', after: ['build'] },
      { key: 'research' }
    ]
    const result = {
      ok: true,
      columns: [['build', 'research'], ['review-a', 'review-b'], ['release']]
    }
    expect(layoutConsoleWorkflow(nodes)).toEqual(result)
    expect(layoutConsoleWorkflow(nodes.toReversed())).toEqual(result)
    expect(nodes[0].after).toEqual(['review-a', 'review-b'])
  })

  it('does not invent a valid ordering for missing nodes, duplicate keys or cycles', () => {
    expect(layoutConsoleWorkflow([{ key: 'a', after: ['missing'] }]).ok).toBe(false)
    expect(layoutConsoleWorkflow([{ key: 'a' }, { key: 'a' }]).ok).toBe(false)
    expect(
      layoutConsoleWorkflow([
        { key: 'a', after: ['b'] },
        { key: 'b', after: ['a'] }
      ]).ok
    ).toBe(false)
  })

  it('treats repeated dependencies as one edge and accepts an empty projection', () => {
    expect(layoutConsoleWorkflow([{ key: 'b', after: ['a', 'a'] }, { key: 'a' }])).toEqual({
      ok: true,
      columns: [['a'], ['b']]
    })
    expect(layoutConsoleWorkflow([])).toEqual({ ok: true, columns: [] })
  })
})
