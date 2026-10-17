import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { downloadWorkflowExport } from '@/lib/console-workflow-client'
import { exportConsoleWorkflowView } from '@/lib/console-workflow-export'
import { translate } from '@/i18n/i18n'
import type { ConsoleWorkflowProgress } from '../../../../shared/console-workflow-types'
import { WorkflowError } from './WorkflowFields'
import { useWorkflowRequest } from './use-workflow-request'

export function WorkflowViewExport({ view }: { view: ConsoleWorkflowProgress }) {
  const request = useWorkflowRequest()
  const save = (format: 'json' | 'mermaid') =>
    void request.run(async () => {
      downloadWorkflowExport(exportConsoleWorkflowView(view, format), format)
    })
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={request.pending} onClick={() => save('json')}>
          <Download />
          {translate('consoleWorkflows.exportJson', 'Export JSON')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={request.pending}
          onClick={() => save('mermaid')}
        >
          <Download />
          {translate('consoleWorkflows.exportMermaid', 'Export Mermaid')}
        </Button>
      </div>
      <WorkflowError message={request.error} />
    </div>
  )
}
