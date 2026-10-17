import { toast } from 'sonner'
import { useLaunchReview } from '@/components/launch-review/launch-review-store'
import { translate } from '@/i18n/i18n'
import { launchManifestAttachesAnything } from '../../../../../../../shared/launch-manifest'
import { launchManifestFor, launchRemovedFor, launchTargetFor } from '../launch-context'
import { launchLocalOllama } from './launch-local-ollama'

/**
 * A Local Ollama start as every provider start: what the launch attaches (a project, template
 * instructions, context) is shown in the review panel first, and only the reviewed list is sent.
 */
export function reviewedLocalOllamaLaunch(args: {
  worktreeId: string | null
  folder: { id: string; name: string } | null
  templateId: string
  tag: string
  onLaunched?: (tabId: string) => void
  onReviewChange?: (reviewing: boolean) => void
}): void {
  const manifest = launchManifestFor(undefined, args.worktreeId, true, args.folder, args.templateId)
  const unticked = launchRemovedFor(manifest)
  const start = (reviewed: typeof manifest, removed: readonly string[]): void => {
    void launchLocalOllama({
      templateId: args.templateId,
      model: args.tag,
      target: launchTargetFor(args.worktreeId),
      onLaunched: args.onLaunched,
      reviewed: { manifest: reviewed, removed: [...new Set([...unticked, ...removed])] }
    })
  }
  if (!launchManifestAttachesAnything(manifest)) {
    start(manifest, [])
    return
  }
  const opened = useLaunchReview.getState().open({
    manifest,
    worktreeId: args.worktreeId,
    onClose: () => args.onReviewChange?.(false),
    onStart: start
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
