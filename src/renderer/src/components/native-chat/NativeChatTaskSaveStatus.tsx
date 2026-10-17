import type { AgentSessionTaskSave } from '../../../../shared/agent-session-wire'
import { translate } from '@/i18n/i18n'

export function NativeChatTaskSaveStatus({
  status
}: {
  status?: AgentSessionTaskSave | null
}): React.JSX.Element | null {
  if (!status) {
    return null
  }
  const labels: Record<AgentSessionTaskSave['state'], string> = {
    saving: translate('components.native-chat.taskSave.saving', 'Saving task note…'),
    pending: translate(
      'components.native-chat.taskSave.pending',
      'Task note saved · Waiting to sync'
    ),
    shared: translate('components.native-chat.taskSave.shared', 'Last task note shared'),
    attention: translate(
      'components.native-chat.taskSave.attention',
      'Task note could not be saved'
    ),
    unavailable: translate(
      'components.native-chat.taskSave.unavailable',
      'Task note status unavailable'
    )
  }
  return (
    <p
      role="status"
      aria-live="polite"
      className="mx-auto min-h-6 w-full max-w-4xl px-4 py-1 text-xs text-muted-foreground"
    >
      {labels[status.state] ?? labels.unavailable}
    </p>
  )
}
