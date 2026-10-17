import { FileText, FolderGit2, Github, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  workflowContextSourceKey,
  workflowContextSourceLabel,
  type WorkflowContextSource
} from '../../../../shared/workflow-context-sources'

function SourceIcon({ source }: { source: WorkflowContextSource }) {
  const className = 'size-3 shrink-0 text-muted-foreground'
  if (source.kind === 'github') {
    return <Github aria-hidden="true" className={className} />
  }
  // A name with an extension reads as a file; the host checks which it really is.
  return /\.[^\\/.]+$/.test(source.path) ? (
    <FileText aria-hidden="true" className={className} />
  ) : (
    <FolderGit2 aria-hidden="true" className={className} />
  )
}

/** The chosen and found sources under the task, each removable; the full path on hover. */
export function WorkflowContextChips({
  sources,
  includesWorkspace,
  onRemove
}: {
  sources: readonly WorkflowContextSource[]
  includesWorkspace: boolean
  onRemove: (source: WorkflowContextSource) => void
}) {
  if (!sources.length) {
    return null
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">
        {includesWorkspace
          ? translate('workflowGraph.context.alsoReads', 'Agents also read:')
          : translate('workflowGraph.context.reads', 'Agents read:')}
      </span>
      {sources.map((source) => {
        const label = workflowContextSourceLabel(source)
        return (
          <span
            key={workflowContextSourceKey(source)}
            title={source.kind === 'path' ? source.path : source.repo}
            className="inline-flex max-w-64 items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-1.5 text-xs"
          >
            <SourceIcon source={source} />
            <span className="truncate">{label}</span>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={translate('workflowGraph.context.remove', 'Remove {{name}}', {
                name: label
              })}
              onClick={() => onRemove(source)}
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </span>
        )
      })}
    </div>
  )
}
