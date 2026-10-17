import { useState } from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { downloadWorkflowExport } from '@/lib/console-workflow-client'
import { exportLocalGraphView, localGraphExportFileName } from '@/lib/local-graph-export'
import type { LocalGraphView } from '@/lib/local-graph-view'
import { translate } from '@/i18n/i18n'

/** The same two exports Lane 3 offers, for a graph this desktop ran itself. */
export function LocalRunViewExport({ view }: { view: LocalGraphView }) {
  const [error, setError] = useState<string | null>(null)
  const save = (format: 'json' | 'mermaid') => {
    try {
      downloadWorkflowExport(
        exportLocalGraphView(view, format),
        format,
        localGraphExportFileName(view, format)
      )
      setError(null)
    } catch (failure) {
      setError(String(failure))
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => save('json')}>
          <Download />
          {translate('auto.components.local-run.Export.json', 'Export JSON')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => save('mermaid')}>
          <Download />
          {translate('auto.components.local-run.Export.mermaid', 'Export Mermaid')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
