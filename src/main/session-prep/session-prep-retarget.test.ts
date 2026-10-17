import { describe, expect, it } from 'vitest'
import type { PreparedFields } from '../../shared/session-prep-types'
import type { SessionPrepRepo } from './session-prep-host'
import { retargetFromReferences } from './session-prep-retarget'

const repo = (id: string, path: string, over: Partial<SessionPrepRepo> = {}): SessionPrepRepo => ({
  id,
  path,
  name: id,
  selector: `id:${id}`,
  isFolder: false,
  isRemote: false,
  ...over
})

const repos = [
  repo('ide', '/work/omni-ide'),
  repo('product', '/work/omnirogue-product'),
  repo('nested', '/work/omnirogue-product/packages/sdk')
]

const fields = (paths: string[]): PreparedFields => ({
  title: 'Rename plan',
  outcome: 'The plan is renamed.',
  doneWhen: ['a', 'b'],
  decided: [],
  references: paths.map((path) => ({ path, why: 'copy' })),
  constraints: [],
  assumptions: [],
  blockingQuestion: null,
  changesCode: true
})

describe('retargetFromReferences', () => {
  it('moves the item to the one repository that holds every absolute reference', () => {
    const result = retargetFromReferences(
      repos,
      'ide',
      fields(['/work/omnirogue-product/apps/pricing.tsx', 'docs/notes.md'])
    )
    expect(result?.repo.id).toBe('product')
    expect(result?.fields.references.map((ref) => ref.path)).toEqual([
      'apps/pricing.tsx',
      'docs/notes.md'
    ])
  })

  it('prefers the innermost repository', () => {
    const result = retargetFromReferences(
      repos,
      'ide',
      fields(['/work/omnirogue-product/packages/sdk/src/plan.ts'])
    )
    expect(result?.repo.id).toBe('nested')
    expect(result?.fields.references[0]?.path).toBe('src/plan.ts')
  })

  it('stays put for relative references, mixed owners, unknown paths or the current repository', () => {
    expect(retargetFromReferences(repos, 'ide', fields(['src/a.ts']))).toBeNull()
    expect(
      retargetFromReferences(
        repos,
        'ide',
        fields(['/work/omnirogue-product/a.ts', '/work/omni-ide/b.ts'])
      )
    ).toBeNull()
    expect(retargetFromReferences(repos, 'ide', fields(['/elsewhere/a.ts']))).toBeNull()
    expect(retargetFromReferences(repos, 'ide', fields(['/work/omni-ide/src/a.ts']))).toBeNull()
  })

  it('does not match a sibling directory that only shares a prefix', () => {
    expect(retargetFromReferences(repos, 'ide', fields(['/work/omni-ide-old/a.ts']))).toBeNull()
  })

  it('moves to the repository the preparer named and keeps outside references absolute', () => {
    const result = retargetFromReferences(repos, 'ide', {
      ...fields(['/Users/maintainer/Desktop/brief.pdf', '/work/omnirogue-product/apps/x.ts']),
      repo: 'omnirogue'
    })
    expect(result?.repo.id).toBe('product')
    expect(result?.fields.references.map((ref) => ref.path)).toEqual([
      '/Users/maintainer/Desktop/brief.pdf',
      'apps/x.ts'
    ])
  })

  it('ignores references outside every repository when choosing where to move', () => {
    const result = retargetFromReferences(
      repos,
      'ide',
      fields(['/Users/maintainer/Desktop/brief.pdf', '/work/omnirogue-product/a.ts'])
    )
    expect(result?.repo.id).toBe('product')
    expect(result?.fields.references[0]?.path).toBe('/Users/maintainer/Desktop/brief.pdf')
  })

  it('never retargets to a remote repository', () => {
    const remote = [repo('ide', '/work/omni-ide'), repo('far', '/work/far', { isRemote: true })]
    expect(retargetFromReferences(remote, 'ide', fields(['/work/far/a.ts']))).toBeNull()
  })
})
