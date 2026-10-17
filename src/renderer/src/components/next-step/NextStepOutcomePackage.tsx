import { useId, useState } from 'react'
import { Package, RefreshCw } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { NextStepHandoffOptions } from '../../../../shared/next-step-draft'
import { SESSION_FOLLOW_UP_MAX_FILES } from '../../../../shared/session-follow-up-rule'
import { CommunicationTypeSelect } from './CommunicationTypeSelect'
import { NextStepTranscriptNotes, NextStepWorkFiles } from './NextStepWorkFiles'
import type { NextStepOutcomeFacts } from './next-step-outcome-facts'
import type { SessionChangedFilesState } from './next-step-session-changes'
import { useHoverOpenPopover } from './use-hover-open-popover'
import { useTranscriptPreview } from './use-transcript-preview'

/** One slot is kept for the summary file, as the work-files list already does. */
export const NEXT_STEP_PACKAGE_MAX_FILES = SESSION_FOLLOW_UP_MAX_FILES - 1

type PackageProps = {
  facts: NextStepOutcomeFacts
  handoff: NextStepHandoffOptions
  onHandoffChange: (patch: Partial<NextStepHandoffOptions>) => void
  /** Send now builds the transcript now; a when-done handoff captures the history at completion. */
  timing?: 'now' | 'done'
  /** Whether the session's history source is settled; a when-done capture records it at save. */
  historyAvailable?: boolean
  /** A person or agent receives the work, so the message can say what kind of communication it is. */
  teamRecipient?: boolean
  /** Files the session's workspace changed, filled in for the person; Refresh reads them again. */
  autoFiles?: SessionChangedFilesState
}

/** "Final summary, 2 files, full conversation" — what the package holds, in a few words. */
export function packageSummary(handoff: NextStepHandoffOptions): string {
  const files = handoff.deliverables?.kind === 'files' ? handoff.deliverables.paths.length : 0
  const parts = [
    handoff.includeSummary ? translate('nextStep.finalSummary', 'final summary') : '',
    files === 1
      ? translate('nextStep.oneFile', '1 file')
      : files > 1
        ? translate('nextStep.fileCount', '{{count}} files', { count: files })
        : '',
    handoff.includeTranscript
      ? translate('nextStep.fullConversationLower', 'full conversation')
      : ''
  ].filter(Boolean)
  const text = parts.length ? parts.join(', ') : translate('nextStep.noteOnly', 'note only')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * The package as one line under the chosen teammate — "Package · Final summary" — that opens
 * the boxes on hover or click. Nothing about it shows before someone receives the work.
 */
export function NextStepOutcomePackageLine(props: PackageProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hover = useHoverOpenPopover({ open, onOpenChange: setOpen })
  const summary = packageSummary(props.handoff)
  return (
    <Popover open={open} onOpenChange={hover.onOpenChange}>
      <PopoverAnchor asChild>
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-1.5 rounded-sm text-left text-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={summary}
          data-next-step-package-line
          {...hover.anchorProps}
        >
          <Package className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="font-medium">{translate('nextStep.package', 'Package')}</span>
          <span className="min-w-0 truncate text-muted-foreground">{` · ${summary}`}</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        className="popover-wheel-scroll max-h-[min(480px,calc(100vh-2rem))] w-[min(440px,calc(100vw-1rem))] overflow-y-auto p-3 scrollbar-sleek"
        aria-label={translate('nextStep.package', 'Package')}
        {...hover.contentProps}
      >
        <NextStepOutcomePackage {...props} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * What travels to the teammate, in one line of boxes: the final summary and named files when
 * ticked (picked natively on this computer, or searched in the workspace); the full
 * conversation once its owner has read what it contains — built here with Send now, captured
 * after the verified completion with a when-done handoff.
 */
export function NextStepOutcomePackage({
  facts,
  handoff,
  onHandoffChange,
  timing = 'done',
  historyAvailable = true,
  teamRecipient = false,
  autoFiles
}: PackageProps): React.JSX.Element {
  const summaryId = useId()
  const filesId = useId()
  const transcriptId = useId()
  const [filesOpen, setFilesOpen] = useState(handoff.deliverables !== null)
  const [error, setError] = useState<string | null>(null)
  const filesOn = filesOpen || handoff.deliverables !== null
  const paths = handoff.deliverables?.kind === 'files' ? handoff.deliverables.paths : []
  const destination = handoff.destinationDirectory ?? facts.workspacePath ?? ''
  const local = parseExecutionHostId(facts.session.hostId ?? 'local')?.kind === 'local'
  const included = handoff.includeTranscript === true
  // Why: a when-done capture needs the history's source at save; Send now reads it right here.
  const historyBlocked = timing !== 'now' && !historyAvailable
  const transcript = useTranscriptPreview({ kind: 'session', session: facts.session }, included)
  const pickFiles = async (): Promise<void> => {
    setError(null)
    try {
      const picked = await window.api.shell.pickFiles({ defaultPath: destination, multiple: true })
      if (!picked?.length) {
        return
      }
      const merged = [...paths, ...picked.filter((path) => !paths.includes(path))].slice(
        0,
        NEXT_STEP_PACKAGE_MAX_FILES
      )
      onHandoffChange({ deliverables: { kind: 'files', paths: merged } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const transcriptOption = {
    included,
    disabled: historyBlocked,
    onToggle: (next: boolean) => onHandoffChange({ includeTranscript: next }),
    preview: transcript.preview,
    error: transcript.error,
    pending: transcript.pending,
    ...(timing === 'now'
      ? {}
      : {
          note: historyBlocked
            ? translate(
                'nextStep.historyUnavailable',
                'The session history source cannot be verified. Reopen this session before saving its history handoff.'
              )
            : translate(
                'nextStep.completeHistoryTiming',
                'History is captured after completion. It includes messages, file contents and command output; protected data or incomplete history pauses delivery for you to review.'
              )
        })
  }
  return (
    <div className="space-y-1.5 text-xs" data-next-step-package>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5">
          <Checkbox
            id={summaryId}
            checked={handoff.includeSummary}
            onCheckedChange={(checked) => onHandoffChange({ includeSummary: checked === true })}
          />
          <label htmlFor={summaryId} className="cursor-pointer">
            {translate('nextStep.includeFinalSummary', 'Include final summary')}
          </label>
        </span>
        <span className="flex items-center gap-1.5">
          <Checkbox
            id={filesId}
            checked={filesOn}
            onCheckedChange={(checked) => {
              const on = checked === true
              setFilesOpen(on)
              if (!on) {
                onHandoffChange({ deliverables: null })
              }
            }}
          />
          <label htmlFor={filesId} className="cursor-pointer">
            {translate('nextStep.packageFiles', 'Files')}
            {paths.length ? ` · ${paths.length}` : ''}
          </label>
          {filesOn && local ? (
            <Button type="button" size="xs" variant="outline" onClick={() => void pickFiles()}>
              {translate('nextStep.addFiles', 'Add files…')}
            </Button>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5">
          <Checkbox
            id={transcriptId}
            checked={included}
            disabled={historyBlocked}
            onCheckedChange={(checked) => transcriptOption.onToggle(checked === true)}
          />
          <label htmlFor={transcriptId} className="cursor-pointer">
            {translate('nextStep.fullConversation', 'Full conversation')}
          </label>
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {filesOn && autoFiles ? (
        // Why: the person sees why these files are already ticked, and can look again later.
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground"
          data-next-step-auto-files
        >
          <span>
            {autoFiles.loading
              ? translate('nextStep.autoFilesLooking', 'Looking for changed files…')
              : autoFiles.detected === null
                ? translate(
                    'nextStep.autoFilesNone',
                    'No changed files found; add the files to send.'
                  )
                : autoFiles.detected.truncated
                  ? translate(
                      'nextStep.autoFilesChangedMore',
                      'The first {{count}} files this workspace changed, captured when the work finishes.',
                      { count: autoFiles.detected.paths.length }
                    )
                  : translate(
                      'nextStep.autoFilesChanged',
                      '{{count}} changed in this workspace, captured when the work finishes.',
                      { count: autoFiles.detected.paths.length }
                    )}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={translate('nextStep.autoFilesRefresh', 'Look again')}
            disabled={autoFiles.loading}
            onClick={autoFiles.refresh}
          >
            <RefreshCw className="size-3" aria-hidden />
            {translate('nextStep.autoFilesRefresh', 'Look again')}
          </Button>
        </div>
      ) : null}
      {filesOn ? (
        <NextStepWorkFiles
          worktreeId={facts.session.worktreeId}
          executionHostId={facts.session.hostId ?? undefined}
          workspacePath={destination}
          deliverables={handoff.deliverables}
          defaults={facts.defaultDeliverables}
          onChange={(deliverables) => onHandoffChange({ deliverables })}
        />
      ) : null}
      {included || historyBlocked ? (
        // Why: the consent text is read when the box is ticked; a blocked history says why at once.
        <div className="space-y-1" data-next-step-transcript>
          <NextStepTranscriptNotes option={transcriptOption} />
        </div>
      ) : null}
      {teamRecipient ? (
        <CommunicationTypeSelect
          value={handoff.communicationType}
          onChange={(communicationType) => onHandoffChange({ communicationType })}
        />
      ) : null}
    </div>
  )
}
