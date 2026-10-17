import { describe, expect, it } from 'vitest'
import { conversationFleetPortableHandoffDeliverables as portable } from './conversation-fleet-handoff-paths'

describe('portable person handoff file identities', () => {
  it('preserves spaces and exact source-relative paths', () => {
    expect(
      portable(
        { kind: 'files', paths: ['/source/final report.md', '/source/output/chart.svg'] },
        '/source'
      )
    ).toEqual({ kind: 'files', paths: ['final report.md', 'output/chart.svg'] })
  })

  it('keeps generated manifest unions without leading current-directory segments', () => {
    expect(
      portable(
        {
          kind: 'manifests',
          manifestPaths: [
            './.omni/runs/work/step-1/manifest.md',
            './.omni/runs/work/step-2/manifest.md'
          ]
        },
        '/source'
      )
    ).toEqual({
      kind: 'manifests',
      manifestPaths: ['.omni/runs/work/step-1/manifest.md', '.omni/runs/work/step-2/manifest.md']
    })
  })

  it('converts Windows source paths without carrying a local drive to the rented Mac', () => {
    expect(
      portable(
        { kind: 'manifest', manifestPath: 'c:\\work\\project\\deliverables\\manifest.md' },
        'C:\\Work\\Project'
      )
    ).toEqual({ kind: 'manifest', manifestPath: 'deliverables/manifest.md' })
  })

  it.each([
    '/source-other/private.md',
    '../private.md',
    '/source/output/../../private.md',
    '.git/config'
  ])('refuses outside or unportable path %s before it is included in the delivery', (path) => {
    expect(() => portable({ kind: 'files', paths: [path] }, '/source')).toThrow(/outside|portable/)
  })
})
