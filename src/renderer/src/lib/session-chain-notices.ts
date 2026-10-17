import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { isSessionFollowUpChain, type SessionChain } from '../../../shared/session-chain-types'

// What the runner tells the person when a chain is queued or cannot find its workspace.
export function queuedToast(chain: SessionChain): string {
  if (chain.steps.length === 0) {
    return translate(
      'nextStep.endSessionSaved',
      'Set. The session closes when it finishes successfully; if anything stops it, it moves to Needs you.'
    )
  }
  const agents = chain.steps.filter((step) => step.kind !== 'handoff').length
  if (isSessionFollowUpChain(chain) && agents === 0) {
    return translate(
      'components.sessionChain.queuedPeopleToast',
      'Saved. When this session finishes, its work goes to the people you chose.'
    )
  }
  if (agents === 1 && chain.steps.length === 1) {
    return translate(
      'auto.components.SessionSidebar.queuedToast',
      'Next session queued. It will start when this session finishes.'
    )
  }
  return translate(
    'components.sessionChain.queuedManyToast',
    '{{count}} sessions queued. Each starts when the one before it finishes.',
    { count: chain.steps.length }
  )
}

/** The workspace a chain after `session` runs in, or null with the reason already shown. */
export function chainWorkspacePath(session: SidebarSession): string | null {
  const workspacePath = useAppStore.getState().getKnownWorktreeById(session.worktreeId)?.path
  if (!workspacePath) {
    toast.error(
      translate(
        'components.sessionChain.workspaceMissing',
        'The source workspace is no longer available.'
      )
    )
    return null
  }
  return workspacePath
}
