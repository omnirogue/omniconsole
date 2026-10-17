import React, { useState } from 'react'
import { Settings2 } from 'lucide-react'
import { AgentAccountSelect } from '@/components/agent/AgentAccountSelect'
import { BuildReviewModelEffortFields } from '@/components/build-review/BuildReviewAgentFields'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { useAppStore } from '@/store'
import {
  resolveAttentionLaunchFavorites,
  upsertAttentionLaunchFavorite,
  type AttentionLaunchFavorite,
  type AttentionLaunchViewMode
} from '../../../../shared/attention-launch-favorites'

function withActorChoice(
  current: AttentionLaunchFavorite,
  next: { model?: string; effort?: string }
): AttentionLaunchFavorite {
  const { model: _model, effort: _effort, ...rest } = current
  return {
    ...rest,
    ...(next.model ? { model: next.model } : {}),
    ...(next.model && next.effort ? { effort: next.effort } : {})
  }
}

/** The popover's form. It mounts on every opening, so each edit starts from the saved favourite. */
function FavoriteEditorForm({
  favorite,
  worktreeId,
  onClose
}: {
  favorite: AttentionLaunchFavorite
  worktreeId: string | null
  onClose: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(favorite)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const settings = useAppStore((state) => state.settings)
  const fieldId = `attention-favorite-${favorite.id}`

  const save = (): void => {
    const label = draft.label.trim()
    if (!label) {
      return
    }
    void updateSettings({
      attentionLaunchFavorites: upsertAttentionLaunchFavorite(
        resolveAttentionLaunchFavorites(settings),
        { ...draft, label }
      )
    })
    onClose()
  }

  return (
    <>
      <div className="space-y-1">
        <Label htmlFor={`${fieldId}-label`}>{translate('attentionLauncher.name', 'Name')}</Label>
        <Input
          id={`${fieldId}-label`}
          value={draft.label}
          maxLength={80}
          onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
        />
      </div>
      <BuildReviewModelEffortFields
        role={fieldId}
        agent={draft.agent}
        worktree={worktreeId ? toRuntimeWorktreeSelector(worktreeId) : ''}
        model={draft.model}
        effort={draft.effort}
        onChange={(next) => setDraft((current) => withActorChoice(current, next))}
      />
      {draft.team ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'attentionLauncher.teamWorkersNote',
            'The lead is asked to start workers on the same model unless your request names an exception.'
          )}
        </p>
      ) : null}
      <AgentAccountSelect
        id={`${fieldId}-account`}
        agent={draft.agent}
        value={draft.accountChoiceId ?? null}
        onChange={(accountChoiceId) => setDraft((current) => ({ ...current, accountChoiceId }))}
      />
      <div className="space-y-1">
        <Label htmlFor={`${fieldId}-view`}>
          {translate('attentionLauncher.opensIn', 'Opens in')}
        </Label>
        <Select
          value={draft.viewMode}
          onValueChange={(value) =>
            setDraft((current) => ({ ...current, viewMode: value as AttentionLaunchViewMode }))
          }
        >
          <SelectTrigger id={`${fieldId}-view`} size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="chat">{translate('attentionLauncher.viewChat', 'Chat')}</SelectItem>
            <SelectItem value="terminal">
              {translate('attentionLauncher.viewTerminal', 'Terminal')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {translate('attentionLauncher.cancel', 'Cancel')}
        </Button>
        <Button size="sm" onClick={save} disabled={!draft.label.trim()}>
          {translate('attentionLauncher.save', 'Save')}
        </Button>
      </div>
    </>
  )
}

/**
 * Edit one saved favourite through the same actor fields the queue and Build & Review use.
 * The launch strip owns the open state so a notice (a removed account) can open this editor.
 */
export function AttentionFavoriteEditor({
  favorite,
  worktreeId,
  open,
  onOpenChange
}: {
  favorite: AttentionLaunchFavorite
  worktreeId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const editLabel = translate('attentionLauncher.editFavorite', 'Edit {{label}}', {
    label: favorite.label
  })
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={editLabel}>
              <Settings2 className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {editLabel}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-80 space-y-3">
        <FavoriteEditorForm
          favorite={favorite}
          worktreeId={worktreeId}
          onClose={() => onOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
