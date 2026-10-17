import { describe, expect, it } from 'vitest'
import type { WorkspaceLinkedItem } from './worktree/types'
import { areWorkspaceLinkedItemsEqual, normalizeWorkspaceLinkedItem } from './workspace-linked-item'

const item: WorkspaceLinkedItem = {
  provider: 'backoffice',
  type: 'issue',
  number: 0,
  title: 'Create customer welcome video',
  url: 'https://console.example.test/work/btk_Content123'
}

describe('normalizeWorkspaceLinkedItem hub metadata', () => {
  it('preserves explicit hub identity and revision zero through persisted JSON', () => {
    const normalized = normalizeWorkspaceLinkedItem({
      ...item,
      hubTaskId: '  btk_Content123  ',
      hubStateRevision: 0,
      hubNextAction: '  Review the first cut  '
    })

    expect(normalized).toEqual({
      ...item,
      hubTaskId: 'btk_Content123',
      hubStateRevision: 0,
      hubNextAction: 'Review the first cut'
    })
    expect(normalizeWorkspaceLinkedItem(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized)
  })

  it.each([
    undefined,
    null,
    '',
    '   ',
    12,
    'btk_',
    'btk_abc',
    `btk_${'a'.repeat(65)}`,
    'task_123',
    'btk_has-hyphen',
    'btk_has_space'
  ])('omits all hub metadata for invalid identity %s', (hubTaskId) => {
    expect(
      normalizeWorkspaceLinkedItem({
        ...item,
        hubTaskId,
        hubStateRevision: 7,
        hubNextAction: 'Send the approved reply'
      })
    ).toEqual(item)
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, Number.NaN, '3', null])(
    'omits invalid revision %s while retaining explicit identity',
    (hubStateRevision) => {
      expect(
        normalizeWorkspaceLinkedItem({
          ...item,
          hubTaskId: 'btk_Content123',
          hubStateRevision,
          hubNextAction: 'Review'
        })
      ).toEqual({ ...item, hubTaskId: 'btk_Content123', hubNextAction: 'Review' })
    }
  )

  it.each(['', '   ', null, 12])('omits invalid next action %s', (hubNextAction) => {
    expect(
      normalizeWorkspaceLinkedItem({
        ...item,
        hubTaskId: 'btk_Content123',
        hubStateRevision: Number.MAX_SAFE_INTEGER,
        hubNextAction
      })
    ).toEqual({
      ...item,
      hubTaskId: 'btk_Content123',
      hubStateRevision: Number.MAX_SAFE_INTEGER
    })
  })

  it.each([
    { ...item, provider: 'github', number: 12, url: 'https://github.com/org/repo/issues/12' },
    { ...item, title: 'btk_Content123 Create customer welcome video' }
  ])('does not infer a binding from legacy title or URL: $title', (legacyItem) => {
    expect(normalizeWorkspaceLinkedItem(legacyItem)).toEqual(legacyItem)
  })
})

describe('areWorkspaceLinkedItemsEqual hub metadata', () => {
  const boundItem: WorkspaceLinkedItem = {
    ...item,
    hubTaskId: 'btk_Content123',
    hubStateRevision: 0,
    hubNextAction: 'Review the first cut'
  }

  it('recognizes an unchanged hub projection', () => {
    expect(areWorkspaceLinkedItemsEqual(boundItem, { ...boundItem })).toBe(true)
  })

  it.each([
    { hubTaskId: 'btk_Content456' },
    { hubTaskId: undefined },
    { hubStateRevision: 1 },
    { hubStateRevision: undefined },
    { hubNextAction: 'Publish the approved cut' },
    { hubNextAction: undefined }
  ])('detects projection changes: %j', (change) => {
    expect(areWorkspaceLinkedItemsEqual(boundItem, { ...boundItem, ...change })).toBe(false)
  })

  it('treats absent and undefined hub metadata as equivalent for unbound work', () => {
    expect(
      areWorkspaceLinkedItemsEqual(item, {
        ...item,
        hubTaskId: undefined,
        hubStateRevision: undefined,
        hubNextAction: undefined
      })
    ).toBe(true)
  })
})
