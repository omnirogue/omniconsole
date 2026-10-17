import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import {
  parseFindScan,
  scanFormat,
  WORKFLOW_FIND_SCAN_MAX_BYTES,
  type FindScanResult,
  type FindScanMapping
} from '../../../../shared/workflow-find-scan'
import {
  WORKFLOW_FIND_MAX_ITEMS,
  type FindImportReceipt,
  type WorkflowFindItem
} from '../../../../shared/workflow-graph'

export function WorkflowFindScan({
  onItems
}: {
  onItems: (items: WorkflowFindItem[], receipt?: FindImportReceipt) => void
}) {
  const [mapping, setMapping] = useState<FindScanMapping>({})
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const active = useRef(true)
  const running = useRef(false)
  const apply = useRef(onItems)
  useEffect(() => {
    apply.current = onItems
  }, [onItems])
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    if (!busy) {
      setLoading(false)
      return
    }
    const timer = setTimeout(() => setLoading(true), 200)
    return () => clearTimeout(timer)
  }, [busy])
  const run = async (read: () => Promise<FindScanResult>) => {
    if (running.current) {
      return
    }
    running.current = true
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const result = await read()
      if (!active.current) {
        return
      }
      setStatus(
        translate(
          'workflowGraph.scan.result',
          '{{count}} options imported; {{skipped}} rows skipped.',
          { count: result.items.length, skipped: result.skipped }
        )
      )
      if (result.items.length >= 2) {
        apply.current(result.items, result.receipt)
      } else {
        setError(
          translate(
            'workflowGraph.scan.tooFew',
            'At least two valid options are needed. Your current list has been kept.'
          )
        )
      }
    } catch (reason) {
      if (active.current) {
        setError(
          translate('workflowGraph.scan.error', 'Could not import the list: {{reason}}', {
            reason: reason instanceof Error ? reason.message : String(reason)
          })
        )
      }
    } finally {
      running.current = false
      if (active.current) {
        setBusy(false)
      }
    }
  }
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          {translate('workflowGraph.scan.open', 'Import a list')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">
        <div className="space-y-2">
          <Label htmlFor="find-scan-file">
            {translate('workflowGraph.scan.file', 'Import a list from a file')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'workflowGraph.scan.hint',
              'CSV or JSON, up to {{max}} rows and 1 MB. Fields named title/name, description/detail and url/link are found automatically. Importing replaces your current list.',
              { max: WORKFLOW_FIND_MAX_ITEMS }
            )}
          </p>
          <div className="space-y-2">
            {(
              [
                ['title', translate('workflowGraph.scan.title', 'Title field (optional)')],
                ['detail', translate('workflowGraph.scan.detail', 'Detail field (optional)')],
                ['url', translate('workflowGraph.scan.url', 'URL field (optional)')]
              ] as const
            ).map(([field, label]) => (
              <Input
                key={field}
                disabled={busy}
                value={mapping[field] ?? ''}
                aria-label={label}
                placeholder={label}
                onChange={(event) =>
                  setMapping({ ...mapping, [field]: event.target.value || undefined })
                }
              />
            ))}
          </div>
          <Input
            id="find-scan-file"
            aria-invalid={!!error}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                void run(async () => {
                  if (file.size > WORKFLOW_FIND_SCAN_MAX_BYTES) {
                    throw new Error(
                      translate('workflowGraph.scan.tooLarge', 'The file is larger than 1 MB.')
                    )
                  }
                  const raw = await file.text()
                  return parseFindScan(raw, scanFormat(file.name, raw), mapping)
                })
              }
            }}
          />
        </div>
        <p role="status" className="min-h-4 text-xs text-muted-foreground">
          {loading ? translate('workflowGraph.scan.loading', 'Importing options…') : status}
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
