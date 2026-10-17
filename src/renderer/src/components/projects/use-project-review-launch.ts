import { fileLaunchInFolder } from '@/lib/pending-folder-launches'
import type { SessionProjectThread } from '@/lib/session-project-threads'
import type { SessionProjectReviewAction } from './SessionProjectThreadOutputs'
import { useProjectFolderLaunch } from './use-project-folder-launch'

/** The built-in Reviewer; a project's own copy of it applies first (#949). */
export const REVIEWER_TEMPLATE_ID = 'reviewer'

export function projectReviewPrompt(
  thread: SessionProjectThread,
  review: { label: string; url: string }
): string {
  return `Review ${review.label} (${review.url}), opened by the thread “${thread.row.session.label}”. Read the diff and its CI, and report what must change before it merges.`
}

/** Review on a Ready for review row: a Reviewer thread of its own, filed in the project. */
export function useProjectReviewLaunch(folder: {
  id: string
  name: string
}): SessionProjectReviewAction {
  const launch = useProjectFolderLaunch(folder)
  return (thread, review) => {
    const prompt = projectReviewPrompt(thread, review)
    launch.start(
      { opening: { prompt, promptDelivery: 'submit-after-ready', note: prompt } },
      {
        templateId: REVIEWER_TEMPLATE_ID,
        onLaunched: (tabId) => fileLaunchInFolder(tabId, folder.id)
      }
    )
  }
}
