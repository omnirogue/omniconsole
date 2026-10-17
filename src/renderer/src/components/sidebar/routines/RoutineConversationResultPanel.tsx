import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'

export function RoutineConversationResultPanel({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="shrink-0 border-b"
      data-routine-results
    >
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="group w-full justify-start rounded-none px-3 text-xs">
          <ChevronRight className="size-4 motion-safe:transition-transform group-data-[state=open]:rotate-90" />
          {translate('routines.results.title', 'Run results')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent
        forceMount
        hidden={!open}
        className="max-h-64 overflow-y-auto scrollbar-sleek"
      >
        <p className="px-3 pt-1 text-xs text-muted-foreground">
          {translate(
            'routines.results.explanation',
            'Results from the latest run. You can keep chatting below.'
          )}
        </p>
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
