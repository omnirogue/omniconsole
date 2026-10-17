import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { WorkDispatchComposer, type WorkDispatchProject } from './WorkDispatchComposer'

export function NeedSpeedDialog({
  open,
  onOpenChange,
  project,
  sourceWorktreeId,
  unavailableReason
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project?: WorkDispatchProject
  sourceWorktreeId?: string
  unavailableReason?: string
}): React.JSX.Element {
  const enabled = useAppStore((state) => state.settings?.automaticOutcomeDispatch !== false)
  const mode = useAppStore((state) => state.settings?.dispatchRoutingMode ?? 'live')
  const updateSettings = useAppStore((state) => state.updateSettings)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto scrollbar-sleek sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{translate('needSpeed.title', 'Need Speed?')}</DialogTitle>
          <DialogDescription>
            {translate(
              'needSpeed.description',
              'Experimental. Enter one or more independent prompts. Reverse Prompting clarifies each objective, then routing chooses models and a way to complete it.'
            )}
          </DialogDescription>
        </DialogHeader>
        {unavailableReason ? (
          <p role="status" className="text-sm text-muted-foreground">
            {unavailableReason}
          </p>
        ) : (
          <WorkDispatchComposer
            project={project}
            sourceWorktreeId={sourceWorktreeId}
            independentObjectives
          />
        )}
        <div className="space-y-2 border-t pt-3">
          <Select
            value={mode}
            onValueChange={(value) => {
              if (value === 'off' || value === 'shadow' || value === 'live') {
                void updateSettings({ dispatchRoutingMode: value })
              }
            }}
          >
            <SelectTrigger aria-label={translate('needSpeed.mode', 'Routing mode')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="live">
                {translate('needSpeed.modeLive', 'On — choose models automatically')}
              </SelectItem>
              <SelectItem value="shadow">
                {translate('needSpeed.modeShadow', 'Observe — suggest without changing models')}
              </SelectItem>
              <SelectItem value="off">
                {translate('needSpeed.modeOff', 'Off — use previous model choices')}
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {translate(
              'needSpeed.modeHelp',
              'Applies to new dispatches on this computer. Changing mode leaves running work in place.'
            )}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={enabled}
              disabled={mode === 'off'}
              onCheckedChange={(checked) => {
                void updateSettings({ automaticOutcomeDispatch: checked === true })
              }}
            />
            {translate('needSpeed.automatic', 'Route new objectives from conversation')}
          </label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'needSpeed.automaticHelp',
              'Follow-ups stay in the current conversation. Start a message with agent: to send it directly. Turn this off to keep new objectives there too.'
            )}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {translate('needSpeed.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
