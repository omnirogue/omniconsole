import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  SESSION_PREP_RPC,
  type SessionPrepItemView,
  type SessionPrepReuseChoice
} from '../../../../shared/session-prep-types'

type OfferedItem = SessionPrepItemView & { reuse: NonNullable<SessionPrepItemView['reuse']> }

/** The pre-selected choice and its label; the other choice is always launching new. */
function keepChoice(item: OfferedItem): { value: SessionPrepReuseChoice; label: string } {
  const { title, why } = item.reuse
  switch (item.reuse.kind) {
    case 'assign':
      return {
        value: 'assign',
        label: translate(
          'sessionPrep.reuseAssign',
          'Give to “{{title}}” ({{why}}) instead of launching',
          { title, why }
        )
      }
    case 'duplicate':
      return {
        value: 'skip',
        label: translate('sessionPrep.reuseDuplicate', 'Already being done by “{{title}}”', {
          title
        })
      }
    case 'conflict-busy':
      return {
        value: 'skip',
        label: translate(
          'sessionPrep.reuseConflictBusy',
          '“{{title}}” is already editing these files ({{why}})',
          { title, why }
        )
      }
  }
}

/**
 * One prepared session an existing session could take, is already doing, or is busy editing the
 * files of: that choice is pre-selected, launching is one click away, and nothing happens until
 * Confirm.
 */
export function SessionPrepReuseOffer({
  batchId,
  item
}: {
  batchId: string
  item: OfferedItem
}): React.JSX.Element {
  const keep = keepChoice(item)
  const [choice, setChoice] = useState<SessionPrepReuseChoice>(keep.value)
  const [sending, setSending] = useState(false)
  const confirm = () => {
    setSending(true)
    void callRuntimeRpc({ kind: 'local' }, SESSION_PREP_RPC.decideReuse, {
      batchId,
      index: item.index,
      choice
    })
      .catch(() => undefined)
      .finally(() => setSending(false))
  }
  return (
    <div
      data-session-prep-reuse={item.index}
      className="mb-1.5 flex flex-col gap-1 text-xs text-muted-foreground"
    >
      <span className="text-foreground">{item.title}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <ToggleGroup
          type="single"
          variant="outline"
          value={choice}
          disabled={sending}
          onValueChange={(value) => {
            if (value === keep.value || value === 'launch') {
              setChoice(value)
            }
          }}
          aria-label={translate('sessionPrep.reuseChoice', 'Where this task goes')}
        >
          <ToggleGroupItem value={keep.value} className="h-6 px-2 text-xs">
            {keep.label}
          </ToggleGroupItem>
          <ToggleGroupItem value="launch" className="h-6 px-2 text-xs">
            {item.reuse.kind === 'assign'
              ? translate('sessionPrep.reuseLaunchNew', 'Launch new')
              : translate('sessionPrep.reuseLaunchAnyway', 'Launch anyway')}
          </ToggleGroupItem>
        </ToggleGroup>
        <Button size="xs" disabled={sending} onClick={confirm}>
          {translate('sessionPrep.reuseConfirm', 'Confirm')}
        </Button>
      </div>
      {item.reuse.failed ? (
        <span className="text-destructive">
          {translate('sessionPrep.reuseFailed', 'Could not give it to that session: {{reason}}', {
            reason: item.reuse.failed
          })}
        </span>
      ) : null}
    </div>
  )
}
