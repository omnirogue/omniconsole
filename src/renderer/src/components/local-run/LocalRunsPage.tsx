import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { WorkflowComposer } from '@/components/console-workflows/WorkflowComposer'
import { translate } from '@/i18n/i18n'
import type { WorkflowDraft } from '@/lib/console-workflow-draft'
import { LocalRunsSection } from './LocalRunsSection'

/**
 * Local runs as their own door: graphs this computer runs itself. Admitting one to the
 * console opens the composer with the stages seeded; the card, organisation, preview and
 * approval still happen there.
 */
export default function LocalRunsPage(): React.JSX.Element {
  useTranslation()
  const [admission, setAdmission] = useState<WorkflowDraft | null>(null)
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-5 py-4">
        <LocalRunsSection onAdmit={setAdmission} />
      </div>
      <Dialog
        open={admission !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAdmission(null)
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto scrollbar-sleek sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {translate('localRuns.admitTitle', 'Admit this graph to the console')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'localRuns.admitHelp',
                'The stages are seeded from your graph; the card, preview and approval still happen here before any job starts.'
              )}
            </DialogDescription>
          </DialogHeader>
          {admission ? (
            <WorkflowComposer
              key={`admission:${admission.title}`}
              initialTaskId={null}
              initialDraft={admission}
              onAdmitted={() => setAdmission(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </main>
  )
}
