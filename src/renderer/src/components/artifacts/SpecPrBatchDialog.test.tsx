// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactListItem } from '../../../../shared/artifacts'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
import { SpecPrBatchDialog } from './SpecPrBatchDialog'

const items = Array.from({ length: 5 }, (_, index): ArtifactListItem => ({
  artifact: {
    version: 1,
    slug: `spec_${index}`,
    title: `Spec ${index + 1}`,
    originalFileName: null,
    sourceContentType: 'text/markdown',
    renderedContentType: 'text/html',
    createdAt: '2026-10-17T00:00:00Z',
    updatedAt: '2026-10-17T00:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z',
    byteSize: 100,
    deletedAt: null,
    revision: 2
  },
  shareUrl: `https://omnios.example/a/spec_${index}`
}))

afterEach(() => {
  rpc.mockReset()
})

describe('Spec PR batch manifest', () => {
  it('submits five exact review identities and target mappings after a single click', async () => {
    rpc.mockImplementation(async (_runtime: unknown, method: string, params: { slug?: string }) => {
      if (method === 'repo.list') {
        return {
          repos: [
            {
              id: 'repo-1',
              displayName: 'OmniConsole',
              kind: 'git',
              worktreeBaseRef: 'main-next',
              gitRemoteIdentity: {
                canonicalKey: 'github.com/omnirogue/omni-ide',
                remoteName: 'origin',
                remoteUrl: 'https://github.com/omnirogue/omni-ide.git'
              }
            }
          ]
        }
      }
      if (method === 'specPrBatch.list') {
        return { batches: [] }
      }
      if (method === 'artifacts.reviewStatus') {
        return {
          status: 'ok',
          value: {
            status: 'approved',
            latest: { id: `decision-${params.slug}`, revision: 2, decision: 'approved' },
            artifact: {
              slug: params.slug,
              revision: 2,
              sourceContentType: 'text/markdown',
              review: {
                question:
                  'Implement this revision in omnirogue/omni-ide against main-next and open a draft PR.'
              }
            }
          }
        }
      }
      if (method === 'specPrBatch.start') {
        return {
          batch: { id: 'spb_test', stopped: false, slots: [], createdAt: '2026-10-17T00:00:00Z' }
        }
      }
      throw new Error(method)
    })
    render(<SpecPrBatchDialog open items={items} onClose={vi.fn()} />)
    const start = await screen.findByRole('button', { name: 'Build 5 draft PRs' })
    await waitFor(() => expect(start).toBeEnabled())
    fireEvent.click(start)
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        { kind: 'local' },
        'specPrBatch.start',
        expect.objectContaining({
          agent: 'codex',
          targets: items.map((item) => ({
            artifactSlug: item.artifact.slug,
            revision: 2,
            decisionId: `decision-${item.artifact.slug}`,
            repoId: 'repo-1',
            baseRef: 'main-next'
          }))
        })
      )
    )
  })
})
