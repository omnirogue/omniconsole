import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { workflowGuide } from './workflow-guide'
import type { WorkflowKind } from './workflow-presets'

const seenKey = (kind: WorkflowKind) => `omni.workflowGuide.seen.${kind}`

// Browser storage is a per-viewer convenience only: without it the guide simply opens again.
function seen(kind: WorkflowKind): boolean {
  try {
    return localStorage.getItem(seenKey(kind)) === '1'
  } catch {
    return false
  }
}

function markSeen(kind: WorkflowKind): void {
  try {
    localStorage.setItem(seenKey(kind), '1')
  } catch {
    // Nothing to remember it in: the guide opens again next time.
  }
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

/** "How this works", open the first time a person meets a workflow, a click away after that. */
export function WorkflowGuideCard(props: { kind: WorkflowKind; className?: string }) {
  // Keyed by workflow, so a setup that changes kind in place opens that workflow's own guide.
  return <GuideCard key={props.kind} {...props} />
}

function GuideCard({ kind, className }: { kind: WorkflowKind; className?: string }) {
  const guide = workflowGuide(kind)
  const [open, setOpen] = useState(() => !seen(kind))
  useEffect(() => markSeen(kind), [kind])
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn('rounded-xl border bg-card text-sm text-card-foreground', className)}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-medium hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
        />
        {translate('localWorkflow.guide.title', 'How this works')}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 px-3 pb-3">
        <p>{guide.what}</p>
        <Part title={translate('localWorkflow.guide.useWhen', 'Use it when')}>
          <ul className="list-disc space-y-0.5 pl-5">
            {guide.useWhen.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Part>
        <Part title={translate('localWorkflow.guide.whatHappens', 'What happens')}>
          <ol className="list-decimal space-y-0.5 pl-5">
            {guide.steps.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </Part>
        <Part title={translate('localWorkflow.guide.youGet', 'What you get back')}>
          <p>{guide.youGet}</p>
        </Part>
        {guide.time ? (
          <Part title={translate('localWorkflow.guide.time', 'How long it takes')}>
            <p>{guide.time}</p>
          </Part>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}
