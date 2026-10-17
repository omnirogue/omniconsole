import { translate } from '@/i18n/i18n'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store'
import { WorkflowSelect, WorkflowError } from '@/components/console-workflows/WorkflowFields'
import { workflowData } from '@/lib/console-workflow-client'
import type { ExactHandoffFile } from '../../../../shared/console-handoff-contract'
import { handoffApi, capturePickedHandoffFile } from './handoff-client'

export function HandoffFilePicker({
  disabled,
  onFile,
  onPendingChange
}: {
  disabled?: boolean
  onFile: (file: ExactHandoffFile) => void
  onPendingChange?: (pending: boolean) => void
}) {
  const id = useId()
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const targets = useAppStore((state) => state.sshTargetLabels)
  const [target, setTarget] = useState('')
  const [path, setPath] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const capture = async (read: () => Promise<ExactHandoffFile>) => {
    setPending(true)
    onPendingChange?.(true)
    setError('')
    try {
      const file = await read()
      if (live.current) {
        onFile(file)
      }
    } catch (reason) {
      if (live.current) {
        setError(reason instanceof Error ? reason.message : 'The file could not be read.')
      }
    } finally {
      if (live.current) {
        setPending(false)
        onPendingChange?.(false)
      }
    }
  }
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {translate('handoffs.attachOriginalFileUpTof5110', 'Attach original file · up to 10 MB')}
      </Label>
      <Input
        id={id}
        type="file"
        disabled={disabled || pending}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) {
            void capture(() => capturePickedHandoffFile(file))
          }
          event.target.value = ''
        }}
      />
      {targets.size > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer py-1">
            {translate('handoffs.fileOnAnotherComputer72206', 'File on another computer')}
          </summary>
          <div className="mt-2 space-y-2">
            <WorkflowSelect
              label={translate('handoffs.computer92464', 'Computer')}
              value={target}
              onChange={setTarget}
              disabled={disabled || pending}
              options={[...targets].map(([value, label]) => ({ value, label }))}
            />
            <Label htmlFor={`${id}-path`}>
              {translate('handoffs.filePathOnThatComputer34e45', 'File path on that computer')}
            </Label>
            <Input
              id={`${id}-path`}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              disabled={disabled || pending}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || pending || !target || !path.trim()}
              onClick={() =>
                void capture(async () =>
                  workflowData(
                    await handoffApi().readFile({ filePath: path.trim(), connectionId: target })
                  )
                )
              }
            >
              {pending
                ? translate('handoffs.readingFile3ab29', 'Reading file…')
                : translate('handoffs.attachFile0c431', 'Attach file')}
            </Button>
          </div>
        </details>
      )}
      <WorkflowError message={error} />
    </div>
  )
}
