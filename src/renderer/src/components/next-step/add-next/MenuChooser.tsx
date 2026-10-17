import type { ReactNode } from 'react'
import { translate } from '@/i18n/i18n'
import type { ConversationSource } from '../../../../../shared/conversation-source'
import type { NextStepSubject } from '../next-step-subject'
import { MenuItem, MenuItems } from './MenuItems'

/**
 * The first list the ＋ menu shows.
 *
 * "New prompt" is first because it is the commonest next step on a running
 * conversation: the next thing the person would have typed into it. It starts no
 * plan, no agent and no card — see `components/prompt-queue`.
 */
export function MenuChooser({
  subject,
  workPlan,
  conversationSource,
  onNewPrompt,
  onKind,
  onBulk
}: {
  subject: NextStepSubject
  workPlan?: ReactNode
  dispatching: boolean
  levelCount: number
  endsOnSuccess: boolean
  conversationSource: ConversationSource | null
  onNewPrompt: () => void
  onKind: (kind: 'agent' | 'person' | null) => void
  onPlanEnd: () => void
  onSent: () => void
  onBulk: () => void
}) {
  return (
    <MenuItems label={translate('nextStep.whatNext', 'WHAT should happen next?')}>
      {conversationSource ? (
        <MenuItem
          label={translate(
            'promptQueue.newPromptHint',
            'Queue a prompt for this agent — sent when it finishes'
          )}
          onChoose={onNewPrompt}
        >
          {translate('promptQueue.newPrompt', 'New prompt')}
        </MenuItem>
      ) : null}
      {workPlan ?? (
        <div role="group" aria-label={translate('nextStep.whereQuestion', 'WHERE')}>
          <p className="px-2 text-xs font-medium">{translate('nextStep.whereQuestion', 'WHERE')}</p>
          <MenuItem onPreview={() => onKind('agent')} onChoose={() => onKind('agent')}>
            {translate('nextStep.agentKind', '🤖 Agent')}
          </MenuItem>
          <MenuItem onPreview={() => onKind('person')} onChoose={() => onKind('person')}>
            {translate('nextStep.personKind', '👤 Person')}
          </MenuItem>
        </div>
      )}
      {subject.kind === 'session' ? (
        <MenuItem onChoose={onBulk}>
          {translate('sessions.bulkActions', 'Session bulk actions')}
        </MenuItem>
      ) : null}
    </MenuItems>
  )
}
