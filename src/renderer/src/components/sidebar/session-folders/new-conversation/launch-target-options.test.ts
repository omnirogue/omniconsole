import { describe, expect, it } from 'vitest'
import { partitionLaunchTargetOptions, type TargetOption } from './launch-target-options'

function option(key: string, placement: TargetOption['placement']): TargetOption {
  return {
    target: { kind: 'workspace', worktreeId: key },
    key,
    name: key,
    detail: `/tmp/${key}`,
    kind: 'repo',
    placement
  }
}

describe('partitionLaunchTargetOptions', () => {
  const options = [
    option('main', { kind: 'top-level' }),
    option('child', { kind: 'under', parentKey: 'main' }),
    option('folder:ops', { kind: 'top-level' }),
    option('from-folder', { kind: 'under', parentKey: 'folder:ops' }),
    option('orphan', { kind: 'existing' }),
    option('under-missing-parent', { kind: 'under', parentKey: 'gone' })
  ]

  it('lists workspaces at the top, children under their parent, and orphans in Existing', () => {
    const result = partitionLaunchTargetOptions(options, 'main')
    expect(result.topLevel.map((entry) => entry.key)).toEqual(['main', 'folder:ops'])
    expect(result.childrenByParentKey.get('main')?.map((entry) => entry.key)).toEqual(['child'])
    expect(result.childrenByParentKey.get('folder:ops')?.map((entry) => entry.key)).toEqual([
      'from-folder'
    ])
    expect(result.existing.map((entry) => entry.key)).toEqual(['orphan', 'under-missing-parent'])
  })

  it('keeps the current target on the top level so "Current" is always visible', () => {
    const result = partitionLaunchTargetOptions(options, 'orphan')
    expect(result.topLevel.map((entry) => entry.key)).toContain('orphan')
    expect(result.existing.map((entry) => entry.key)).not.toContain('orphan')
  })
})
