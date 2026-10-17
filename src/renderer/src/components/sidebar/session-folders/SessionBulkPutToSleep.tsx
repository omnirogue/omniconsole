import { useState } from 'react'
import { Moon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { planCurrentSessionSleep } from '@/lib/session-sleep-target'
import { useAppStore } from '@/store'
import type { SessionBulkItem } from './SessionBulkNextStep'
import type { SessionBulkOutcome } from './session-bulk-outcome'
import { sleepableSessionItems, sleepSessionItems } from './session-bulk-sleep'

/** "Put to sleep (n)" for the selection: frees every selected agent that can resume later. */
export function SessionBulkPutToSleep({
  items,
  disabled,
  onFinished
}: {
  items: readonly SessionBulkItem[]
  disabled: boolean
  onFinished: (outcomes: SessionBulkOutcome[]) => void
}): React.JSX.Element {
  // Why: re-count when a pane starts, exits or learns its conversation id.
  useAppStore((state) => state.ptyIdsByTabId)
  useAppStore((state) => state.agentStatusByPaneKey)
  const [pending, setPending] = useState(false)
  const sleepable = sleepableSessionItems(items, planCurrentSessionSleep)
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="gap-1"
      disabled={disabled || pending || sleepable.length === 0}
      data-session-bulk-action="sleep"
      title={translate(
        'conversations.bulkSleepHint',
        'Stop the selected agents to free CPU and memory; open one to resume it.'
      )}
      onClick={() => {
        setPending(true)
        void sleepSessionItems(sleepable)
          .then(onFinished)
          .finally(() => setPending(false))
      }}
    >
      <Moon className="size-3" />
      {translate('conversations.bulkSleep', 'Put to sleep ({{count}})', {
        count: sleepable.length
      })}
    </Button>
  )
}
