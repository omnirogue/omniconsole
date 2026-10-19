import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { EvolveRunRecord } from '../../../../shared/evolve-workflow'
import {
  estimateHostedEvolveCredits,
  type EvolveDraft
} from '../../../../shared/evolve-workflow-draft'
import {
  createEvolveWarmStartDraft,
  defaultEvolveWarmStartLabels,
  findEvolveWarmStartWinner,
  type EvolveWarmStartLabels
} from './evolve-warm-start-helpers'

export type EvolveWarmStartModalProps = {
  open: boolean
  worktreeId: string
  runs: readonly EvolveRunRecord[]
  draft: EvolveDraft
  labels?: Partial<EvolveWarmStartLabels>
  onOpenChange: (open: boolean) => void
  onConfirm: (draft: EvolveDraft) => void | Promise<void>
}

export function EvolveWarmStartModal(props: EvolveWarmStartModalProps) {
  if (!props.open) {
    return null
  }
  return <WarmStartDialog {...props} />
}

function WarmStartDialog({
  worktreeId,
  runs,
  draft,
  labels: overrides,
  onOpenChange,
  onConfirm
}: EvolveWarmStartModalProps) {
  const labels = { ...defaultEvolveWarmStartLabels, ...overrides }
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const submitting = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  const winner = findEvolveWarmStartWinner(runs, { ...draft, worktreeId })
  const quote = estimateHostedEvolveCredits({
    executionTier: draft.executionTier,
    target: draft.target,
    iterations: draft.iterations
  })

  const close = () => {
    if (!submitting.current) {
      onOpenChange(false)
    }
  }

  const confirm = async () => {
    if (!winner || submitting.current) {
      return
    }
    submitting.current = true
    setPending(true)
    setFailed(false)
    try {
      await onConfirm(createEvolveWarmStartDraft(draft, winner))
    } catch {
      if (active.current) {
        submitting.current = false
        setPending(false)
        setFailed(true)
      }
      return
    }
    if (active.current) {
      submitting.current = false
      setPending(false)
      onOpenChange(false)
    }
  }

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[85vh] overflow-y-auto scrollbar-sleek"
      >
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault()
            void confirm()
          }}
        >
          {winner ? (
            <>
              <section
                className="space-y-3 rounded-md border border-border p-3"
                aria-label={labels.winner}
              >
                <h3 className="text-sm font-medium">{labels.winner}</h3>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">{labels.target}</dt>
                  <dd className="break-words">{winner.target}</dd>
                  <dt className="text-muted-foreground">{labels.run}</dt>
                  <dd className="break-all font-mono">{winner.ledgerRunId ?? winner.runId}</dd>
                  <dt className="text-muted-foreground">{labels.candidate}</dt>
                  <dd className="break-all font-mono">
                    {winner.candidateId ?? labels.unavailable}
                  </dd>
                  <dt className="text-muted-foreground">{labels.score}</dt>
                  <dd>
                    {winner.bestScore == null
                      ? labels.unavailable
                      : labels.formatScore(winner.bestScore)}
                  </dd>
                </dl>
              </section>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                <dt className="text-muted-foreground">{labels.executionTier}</dt>
                <dd>
                  {quote.executionTier === 'hosted_pro'
                    ? labels.hostedPro
                    : labels.hostedSuperIntelligence}
                </dd>
                <dt className="text-muted-foreground">{labels.iterations}</dt>
                <dd>{labels.formatCount(quote.iterations)}</dd>
                <dt className="text-muted-foreground">{labels.credits}</dt>
                <dd>{labels.formatCount(quote.estimatedCredits)}</dd>
              </dl>
              <p className="text-xs text-muted-foreground">{labels.estimateHint}</p>
              <p className="text-xs text-muted-foreground">{labels.auditHint}</p>
            </>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {labels.empty}
            </p>
          )}
          {failed && (
            <p role="alert" className="text-sm text-destructive">
              {labels.error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={close}>
              {labels.cancel}
            </Button>
            <Button type="submit" size="sm" disabled={pending || !winner}>
              {pending ? labels.pending : labels.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
