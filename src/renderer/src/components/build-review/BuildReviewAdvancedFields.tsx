import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

/**
 * Settings most runs never touch. Linking a task is optional: without one the run is ordinary
 * local work; with one, the run and its agents are bound to that board card.
 */
export function BuildReviewAdvancedFields({
  taskId,
  onTaskIdChange,
  taskIdValid
}: {
  taskId: string
  onTaskIdChange: (taskId: string) => void
  taskIdValid: boolean
}) {
  // Why initialised from the draft: a saved link must stay visible, not hide behind a fold.
  const [open, setOpen] = useState(() => taskId.trim() !== '')
  const expanded = open || !taskIdValid
  return (
    <Collapsible open={expanded} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="group -ml-2 text-xs">
          {translate('buildReview.form.advanced', 'Advanced')}
          <ChevronDown
            aria-hidden="true"
            className="size-3 text-muted-foreground motion-safe:transition-transform group-data-[state=open]:rotate-180"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 pt-2">
          <Label htmlFor="build-review-card">
            {translate('buildReview.form.linkTask', 'Link a task (optional)')}
          </Label>
          <Input
            id="build-review-card"
            placeholder={translate('buildReview.cardPlaceholder', 'btk_…')}
            value={taskId}
            onChange={(event) => onTaskIdChange(event.target.value)}
            aria-invalid={!taskIdValid}
            aria-describedby="build-review-card-help"
          />
          <p
            id="build-review-card-help"
            className={taskIdValid ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}
          >
            {taskIdValid
              ? translate(
                  'buildReview.form.linkTaskHelp',
                  'Only for work tracked on a board card. Leave blank for ordinary local work.'
                )
              : translate(
                  'buildReview.form.linkTaskInvalid',
                  'Enter a task ID that starts with btk_, or leave this blank.'
                )}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
