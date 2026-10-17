import { describe, expect, it } from 'vitest'
import type { PlannedItem } from '../../shared/session-prep-types'
import { foldOrderedItems } from './session-prep-order'

const item = (title: string, extra: Partial<PlannedItem> = {}): PlannedItem => ({
  title,
  ask: `Do ${title}`,
  anchor: title.toLowerCase(),
  direct: false,
  changesCode: false,
  ...extra
})

describe('foldOrderedItems', () => {
  it('leaves unordered items untouched', () => {
    const items = [item('A'), item('B')]
    expect(foldOrderedItems(items)).toBe(items)
  })

  it('folds a stated chain into one session in order', () => {
    const folded = foldOrderedItems([
      item('Schema', { changesCode: true, repoHint: 'omni' }),
      item('UI one', { after: [0] }),
      item('UI two', { after: [0] }),
      item('Docs')
    ])
    expect(folded).toHaveLength(2)
    expect(folded[0]).toEqual({
      title: 'Schema → UI one → UI two',
      ask: 'Do Schema\nThen, once that is done: Do UI one\nThen, once that is done: Do UI two',
      anchor: 'schema',
      direct: false,
      changesCode: true,
      repoHint: 'omni'
    })
    expect(folded[1]).toEqual(item('Docs'))
  })

  it('joins two chains that share a later item', () => {
    const folded = foldOrderedItems([item('A'), item('B'), item('C', { after: [0, 1] })])
    expect(folded).toHaveLength(1)
    expect(folded[0]?.ask).toBe(
      'Do A\nThen, once that is done: Do B\nThen, once that is done: Do C'
    )
  })

  it('never produces a direct item from a chain and drops after from singles', () => {
    const folded = foldOrderedItems([
      item('A', { direct: true }),
      item('B', { direct: true, after: [0] }),
      item('C', { after: [] })
    ])
    expect(folded[0]?.direct).toBe(false)
    expect(folded[1]).not.toHaveProperty('after')
  })

  it('names the repository of a later part that differs from the first', () => {
    const folded = foldOrderedItems([
      item('Schema', { repoHint: 'omni' }),
      item('Site', { after: [0], repoHint: 'marketing' }),
      item('Tests', { after: [1], repoHint: 'omni' })
    ])
    expect(folded[0]?.ask).toBe(
      'Do Schema\nThen, once that is done (in marketing): Do Site\nThen, once that is done: Do Tests'
    )
    expect(folded[0]?.repoHint).toBe('omni')
  })

  it('keeps long chain titles within 60 characters', () => {
    const long = 'x'.repeat(40)
    const folded = foldOrderedItems([item(long), item(long, { after: [0] })])
    expect(folded[0]!.title.length).toBeLessThanOrEqual(60)
  })
})
