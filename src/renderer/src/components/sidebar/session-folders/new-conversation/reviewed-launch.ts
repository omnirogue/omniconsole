import { toast } from 'sonner'
import { readLaunchSessionContext } from '@/lib/launch-session-context'
import { refreshOpenLaunchProjectDocuments } from '@/lib/project-launch'
import { translate } from '@/i18n/i18n'
import { useLaunchReview } from '@/components/launch-review/launch-review-store'
import {
  launchManifestAttachesAnything,
  type LaunchManifest
} from '../../../../../../shared/launch-manifest'
import { launchManifestFor, launchRemovedFor, pickFromLaunchManifest } from './launch-context'
import type { LaunchPick } from './resolve-launch-plan'
import type { LauncherCompany } from './launcher-target'

/**
 * Sidebar provider launches: build the list of everything the launcher attaches, and when it
 * attaches anything (a folder, a project, template instructions, context), show it in the review
 * panel first; Start sends only the reviewed list. A bare provider launch starts at once.
 */
export function reviewedLaunchStart(args: {
  launch: {
    captureOwner?: () => () => boolean
    prepareReviewPick?: (pick?: LaunchPick) => LaunchPick
    start: (pick?: LaunchPick, company?: LauncherCompany) => Promise<void>
  }
  onReviewChange?: (reviewing: boolean) => void
  worktreeId: string | null
  local: boolean
  folder: { id: string; name: string } | undefined
  /** The template every launch from here opens with (a project's chat); else the remembered one. */
  templateId?: string
}): (pick?: LaunchPick, company?: LauncherCompany) => void {
  return (requestedPick, company) => {
    const pick = {
      ...(args.launch.prepareReviewPick?.(requestedPick) ?? requestedPick),
      launchContextClaim: readLaunchSessionContext(args.worktreeId).claim
    }
    const ownerIsCurrent = args.launch.captureOwner?.()
    const review = (): void => {
      const manifest = launchManifestFor(
        pick,
        args.worktreeId,
        args.local,
        args.folder ?? null,
        args.templateId
      )
      const unticked = launchRemovedFor(manifest)
      const start = (reviewed: LaunchManifest, removed: readonly string[] = []) => {
        if (ownerIsCurrent && !ownerIsCurrent()) {
          toast.error(
            translate(
              'computerPicker.launchHostChanged',
              'The selected computer changed. Reopen the launcher to start there.'
            )
          )
          return
        }
        void args.launch.start(
          pickFromLaunchManifest(pick, reviewed, [...unticked, ...removed]),
          company
        )
      }
      if (!launchManifestAttachesAnything(manifest)) {
        start(manifest)
        return
      }
      const opened = useLaunchReview.getState().open({
        manifest,
        worktreeId: args.worktreeId,
        onClose: () => args.onReviewChange?.(false),
        onStart: (reviewed, removed) => start(reviewed, removed)
      })
      if (opened) {
        args.onReviewChange?.(true)
      } else {
        toast.info(
          translate(
            'launchReview.alreadyOpen',
            'Another launch is waiting for review. Start or cancel it first.'
          )
        )
      }
    }
    // Why: a project launch lists today's text of its notes and documents, not the saved copy.
    const refreshing = refreshOpenLaunchProjectDocuments()
    if (refreshing) {
      void refreshing.then(review)
    } else {
      review()
    }
  }
}
