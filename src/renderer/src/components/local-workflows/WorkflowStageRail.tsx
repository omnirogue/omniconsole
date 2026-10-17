import type { ReactNode, RefObject } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { RailBadge, type RailBadgeTone } from '../next-action/up-next-rail'
import type { WorkflowStageModel, WorkflowStageTone } from './workflow-run-stages'

const RAIL_TONE: Record<WorkflowStageTone, RailBadgeTone> = {
  queued: 'queued',
  running: 'running',
  paused: 'needs-you',
  done: 'done',
  failed: 'failed',
  stopped: 'idle'
}

function badgeGlyph(stage: WorkflowStageModel): string {
  switch (stage.tone) {
    case 'done':
      return '✓'
    case 'failed':
      return '!'
    case 'queued':
    case 'running':
    case 'paused':
    case 'stopped':
      return String(stage.index + 1)
  }
}

function toneLabel(tone: WorkflowStageTone): string {
  switch (tone) {
    case 'queued':
      return translate('localWorkflow.run.stageQueued', 'Not started')
    case 'running':
      return translate('localWorkflow.run.stageRunning', 'Working')
    case 'paused':
      return translate('localWorkflow.run.stageHeld', 'Paused')
    case 'done':
      return translate('localWorkflow.run.stageDone', 'Done')
    case 'failed':
      return translate('localWorkflow.run.stageFailed', 'Failed')
    case 'stopped':
      return translate('localWorkflow.run.stageStopped', 'Stopped before it finished')
  }
}

function heldLine(stage: WorkflowStageModel): string {
  const inFlight = stage.calls.some((call) => call.state === 'running' || call.state === 'queued')
  return inFlight
    ? translate('localWorkflow.run.stagePaused', 'Paused. Work in progress will finish.')
    : translate('localWorkflow.run.stageHeldIdle', 'Paused.')
}

/** A vertical stage rail in the Up Next style: the line runs through every badge. */
export function WorkflowStageRail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ol
      aria-label={label}
      className="relative space-y-6 before:absolute before:top-3 before:bottom-3 before:left-[9px] before:w-0.5 before:bg-border"
    >
      {children}
    </ol>
  )
}

/**
 * One stage: badge, name, progress and, while it works, a plain-language line. The body shows
 * once the stage has started; settled stages can fold away behind their header.
 */
export function WorkflowStageItem({
  stage,
  meta,
  open = true,
  onToggle,
  itemRef,
  children
}: {
  stage: WorkflowStageModel
  /** Extra progress words after done/total, e.g. "round 2 of 3". */
  meta?: ReactNode
  open?: boolean
  onToggle?: () => void
  /** The stage a finished run scrolls to (its answer or report). */
  itemRef?: RefObject<HTMLLIElement | null>
  children?: ReactNode
}) {
  const working = stage.tone === 'running' || stage.tone === 'paused'
  const heading = (
    <>
      <span
        className={cn(
          'text-sm font-medium',
          stage.tone === 'queued' ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        {stage.label}
      </span>
      <span className="sr-only">{toneLabel(stage.tone)}</span>
      {stage.total > 0 && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {stage.completed}/{stage.total}
        </span>
      )}
      {stage.failed > 0 && (
        <span className="text-xs text-destructive">
          {translate('localWorkflow.run.failedCount', '{{count}} failed', {
            count: stage.failed
          })}
        </span>
      )}
      {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
    </>
  )
  return (
    <li
      ref={itemRef}
      className="relative scroll-mt-4 pl-8"
      data-stage-id={stage.id}
      data-stage-tone={stage.tone}
    >
      <RailBadge tone={RAIL_TONE[stage.tone]} className="top-0 left-0">
        {badgeGlyph(stage)}
      </RailBadge>
      {onToggle ? (
        <button
          type="button"
          aria-expanded={open}
          className="group flex min-h-5 flex-wrap items-center gap-x-2 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          onClick={onToggle}
        >
          {heading}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3.5 text-muted-foreground transition-transform',
              open && 'rotate-90'
            )}
          />
        </button>
      ) : (
        <div className="flex min-h-5 flex-wrap items-center gap-x-2">{heading}</div>
      )}
      {working && (
        <p className="mt-0.5 text-xs text-muted-foreground" aria-live="polite">
          {stage.tone === 'paused' ? heldLine(stage) : stage.activeLine}
        </p>
      )}
      {open && children ? <div className="mt-3">{children}</div> : null}
    </li>
  )
}
