import { describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewStatus } from '../../../../../shared/artifact-review'
import { resolvePersonReviewPage } from './person-review-page'

const LINK = 'https://console.example.com/a/launch-plan'

function status(patch: { isOwner?: boolean; title?: string | null; shareUrl?: string } = {}) {
  return {
    artifact: {
      slug: 'launch-plan',
      title: patch.title === undefined ? 'Launch plan' : patch.title,
      originalFileName: 'launch-plan.md'
    },
    shareUrl: patch.shareUrl ?? LINK,
    status: 'pending',
    latest: null,
    decisions: [],
    viewer: { signedIn: true, isOwner: patch.isOwner ?? true, canDecide: false }
  } as unknown as ArtifactReviewStatus
}

describe('attaching a page for review', () => {
  it('reads the page for its title and keeps its own link', async () => {
    const read = vi.fn(async () => status())
    await expect(resolvePersonReviewPage(` ${LINK}/content `, read)).resolves.toEqual({
      ok: true,
      review: { slug: 'launch-plan', title: 'Launch plan', url: LINK }
    })
    expect(read).toHaveBeenCalledWith('launch-plan')
  })

  it('falls back to the file name, and to the pasted link when the server link differs', async () => {
    const read = async () => status({ title: null, shareUrl: 'https://elsewhere.test/x' })
    await expect(resolvePersonReviewPage(LINK, read)).resolves.toEqual({
      ok: true,
      review: { slug: 'launch-plan', title: 'launch-plan.md', url: LINK }
    })
  })

  it('warns, but attaches, a page this person did not publish', async () => {
    const result = await resolvePersonReviewPage(LINK, async () => status({ isOwner: false }))
    expect(result).toMatchObject({ ok: true, warning: expect.stringContaining('did not publish') })
  })

  it('refuses a link that is not an omnios page, without reading anything', async () => {
    const read = vi.fn(async () => status())
    await expect(resolvePersonReviewPage('https://example.com/doc', read)).resolves.toMatchObject({
      ok: false
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses a page that cannot be read', async () => {
    await expect(resolvePersonReviewPage(LINK, async () => null)).resolves.toMatchObject({
      ok: false
    })
    await expect(
      resolvePersonReviewPage(LINK, async () => {
        throw new Error('offline')
      })
    ).resolves.toMatchObject({ ok: false })
  })
})
