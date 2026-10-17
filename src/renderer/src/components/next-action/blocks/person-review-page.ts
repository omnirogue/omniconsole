import { translate as t } from '@/i18n/i18n'
import type { ArtifactReviewStatus } from '../../../../../shared/artifact-review'
import {
  normalizeHandoffArtifactReview,
  parseArtifactReviewLink,
  type HandoffArtifactReview
} from '../../../../../shared/handoff-artifact-review'

export type PersonReviewPageResult =
  | { ok: true; review: HandoffArtifactReview; warning?: string }
  | { ok: false; message: string }

/**
 * The page a pasted link names, with the title and link the recipient will see. The server's own
 * share link wins; the pasted link is kept only when it names the same page. A page this person did
 * not publish is still attached, with a warning: the send succeeds only if the recipient is
 * already one of its reviewers.
 */
export async function resolvePersonReviewPage(
  input: string,
  read: (slug: string) => Promise<ArtifactReviewStatus | null>
): Promise<PersonReviewPageResult> {
  const slug = parseArtifactReviewLink(input)
  if (!slug) {
    return {
      ok: false,
      message: t(
        'upNext.send.reviewPageBadLink',
        'Paste an omnios page link (…/a/<id>) or the page id.'
      )
    }
  }
  const status = await read(slug).catch(() => null)
  if (!status) {
    return {
      ok: false,
      message: t(
        'upNext.send.reviewPageUnreadable',
        'That page could not be read. Check the link, or sign in to OmniConsole again.'
      )
    }
  }
  const title = status.artifact.title?.trim() || status.artifact.originalFileName?.trim() || slug
  // Why two reads: normalizing drops a link that does not name this page, never the page itself.
  const shared = normalizeHandoffArtifactReview({ slug, title, url: status.shareUrl })
  const pasted = normalizeHandoffArtifactReview({ slug, title, url: input.trim() })
  const withLink = shared?.url ? shared : (pasted ?? { slug, title })
  return status.viewer.isOwner
    ? { ok: true, review: withLink }
    : {
        ok: true,
        review: withLink,
        warning: t(
          'upNext.send.reviewPageNotOwner',
          'You did not publish this page, so you cannot add reviewers to it. It sends only if they already review it.'
        )
      }
}
