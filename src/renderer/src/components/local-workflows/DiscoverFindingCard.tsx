import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { WorkflowProviderIcon as AgentIcon } from '@/lib/workflow-provider-icon'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { WorkflowMarkdown } from './WorkflowMarkdown'
import type {
  LocalWorkflowDiscoverFinding,
  LocalWorkflowDiscoverSeverity
} from '../../../../shared/local-workflow-view'
import {
  discoverFindingStatusLabel,
  discoverLensLabel,
  severityLabel,
  verifyLensLabel
} from './local-workflow-labels'

const SEVERITY_CLASS: Record<LocalWorkflowDiscoverSeverity, string> = {
  critical: 'border-destructive/30 bg-destructive/10 text-destructive',
  high: 'border-status-warning-border bg-status-warning-background text-status-warning',
  medium: 'border-border bg-muted text-muted-foreground',
  low: 'border-border bg-transparent text-muted-foreground'
}

export function SeverityChip({ severity }: { severity: LocalWorkflowDiscoverSeverity }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-medium',
        SEVERITY_CLASS[severity]
      )}
    >
      {severityLabel(severity)}
    </span>
  )
}

/** file:line opens the file when the host can, otherwise copies it. */
export function WorkflowLocation({
  location,
  onOpen
}: {
  location: string
  onOpen?: (location: string) => void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={
        onOpen
          ? translate('localWorkflow.discoverRun.openLocation', 'Open in editor')
          : translate('localWorkflow.discoverRun.copyLocation', 'Copy location')
      }
      className="max-w-full truncate rounded-sm font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      onClick={() => {
        if (onOpen) {
          onOpen(location)
          return
        }
        void window.api?.ui
          ?.writeClipboardText(location)
          .then(() => setCopied(true))
          .catch(() => {})
      }}
    >
      {copied ? translate('localWorkflow.discoverRun.copied', 'Copied') : location}
    </button>
  )
}

type Vote = LocalWorkflowDiscoverFinding['votes'][number]

function voteGlyph(vote: Vote): { glyph: string; className: string } {
  if (vote.state === 'running') {
    return { glyph: '', className: 'border-status-info bg-status-info motion-safe:animate-pulse' }
  }
  if (vote.state === 'failed') {
    return { glyph: '!', className: 'border-border text-muted-foreground' }
  }
  switch (vote.verdict) {
    case 'real':
      return {
        glyph: '✓',
        className: 'border-status-success-border bg-status-success-background text-status-success'
      }
    case 'refuted':
      return { glyph: '✗', className: 'border-destructive/30 bg-destructive/10 text-destructive' }
    case 'unjudged':
      return { glyph: '?', className: 'border-border bg-muted text-muted-foreground' }
    case undefined:
      return { glyph: '', className: 'border-dashed border-muted-foreground/40' }
  }
}

/** Three verdict dots that fill in as votes land: ✓ real, ✗ refuted, ? unjudged. */
function VerdictDots({ votes }: { votes: Vote[] }) {
  const tally = (verdict: Vote['verdict']) =>
    votes.filter((vote) => vote.verdict === verdict).length
  return (
    <span className="flex shrink-0 items-center gap-1">
      {votes.map((vote) => {
        const { glyph, className } = voteGlyph(vote)
        return (
          <span
            key={`${vote.lens}-${vote.seat.seatId}`}
            aria-hidden="true"
            className={cn(
              'grid size-4 place-items-center rounded-full border text-[9px] font-semibold leading-none',
              className
            )}
          >
            {glyph}
          </span>
        )
      })}
      <span className="sr-only">
        {translate(
          'localWorkflow.discoverRun.voteSummary',
          '{{real}} real, {{refuted}} refuted, {{unjudged}} unjudged',
          { real: tally('real'), refuted: tally('refuted'), unjudged: tally('unjudged') }
        )}
      </span>
    </span>
  )
}

const STATUS_CLASS: Record<LocalWorkflowDiscoverFinding['status'], string> = {
  verifying: 'text-status-info',
  confirmed: 'text-status-success',
  refuted: 'text-muted-foreground line-through decoration-muted-foreground/40',
  unverified: 'text-muted-foreground'
}

/** One live finding: appears when a finder returns it, fills in as verifiers vote. */
export function DiscoverFindingCard({
  finding,
  onOpenLocation
}: {
  finding: LocalWorkflowDiscoverFinding
  onOpenLocation?: (location: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <li className="rounded-lg border bg-card" data-finding-status={finding.status}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 px-3 pt-2.5 text-left focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        onClick={() => setOpen(!open)}
      >
        <SeverityChip severity={finding.severity} />
        <span className="min-w-0 flex-1 text-sm font-medium leading-5">{finding.title}</span>
        <VerdictDots votes={finding.votes} />
        <span
          className={cn(
            'min-w-20 shrink-0 whitespace-nowrap text-right text-xs',
            STATUS_CLASS[finding.status]
          )}
        >
          {discoverFindingStatusLabel(finding)}
        </span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
        />
      </button>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pt-1 pb-2.5 text-[11px] text-muted-foreground">
        <WorkflowLocation location={finding.location} onOpen={onOpenLocation} />
        <span className="flex items-center gap-1">
          <AgentIcon agent={finding.foundBy.agent} size={11} />
          {finding.foundBy.modelLabel}
        </span>
        <span>{discoverLensLabel(finding.lens)}</span>
      </div>
      {open && (
        <div className="space-y-3 border-t px-3 py-3">
          <WorkflowMarkdown className="text-sm" content={finding.markdown} />
          {finding.votes.some((vote) => vote.reason) && (
            <ul className="space-y-1.5 text-xs">
              {finding.votes.map((vote) => (
                <li key={`${vote.lens}-${vote.seat.seatId}`} className="flex gap-2">
                  <AgentIcon agent={vote.seat.agent} size={12} />
                  <span className="min-w-0">
                    <span className="font-medium">{verifyLensLabel(vote.lens)}</span>{' '}
                    <span className="text-muted-foreground">
                      {vote.seat.modelLabel}
                      {vote.reason ? ` — ${vote.reason}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}
