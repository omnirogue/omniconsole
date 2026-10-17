import { translate } from '@/i18n/i18n'
import type { SessionProjectThreadGroupKey } from '@/lib/session-project-thread-groups'

export function sessionProjectThreadGroupLabel(key: SessionProjectThreadGroupKey): string {
  switch (key) {
    case 'needsYou':
      return translate('projects.status.needsYou', 'Needs you')
    case 'reviewReady':
      return translate('projects.status.reviewReady', 'Ready for review')
    case 'working':
      return translate('projects.status.working', 'Working')
    case 'waiting':
      return translate('projects.status.waiting', 'Waiting')
    case 'done':
      return translate('projects.status.done', 'Done')
    case 'stopped':
      return translate('projects.status.stopped', 'Failed')
    case 'cantSee':
      return translate('projects.status.cantSee', "Can't see")
    case 'idle':
      return translate('projects.status.idle', 'Idle')
  }
}

/** A pull or merge request's state on a chip. */
export function reviewStateLabel(state: 'open' | 'closed' | 'merged' | 'draft'): string {
  switch (state) {
    case 'open':
      return translate('projects.outputs.reviewOpen', 'open')
    case 'draft':
      return translate('projects.outputs.reviewDraft', 'draft')
    case 'merged':
      return translate('projects.outputs.reviewMerged', 'merged')
    case 'closed':
      return translate('projects.outputs.reviewClosed', 'closed')
  }
}
