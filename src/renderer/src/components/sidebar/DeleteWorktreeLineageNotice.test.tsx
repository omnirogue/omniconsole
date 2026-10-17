import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''))
}))

import { DeleteWorktreeLineageNotice } from './DeleteWorktreeLineageNotice'

describe('DeleteWorktreeLineageNotice (PR4 review N3)', () => {
  it('names every child that will be deleted, not just the first few', () => {
    const children = Array.from(
      { length: 6 },
      (_, i) => ({ id: `wt-${i}`, displayName: `child-${i}`, path: `/w/${i}` }) as Worktree
    )
    const markup = renderToStaticMarkup(
      <DeleteWorktreeLineageNotice
        descendants={children}
        dirtyChangeCountsByWorktreeId={new Map()}
      />
    )
    for (const child of children) {
      expect(markup).toContain(child.displayName)
    }
    expect(markup).not.toContain('more')
  })
})
