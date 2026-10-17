import { useId, useState } from 'react'
import { Paperclip, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { useRuntimeFileListForWorktree } from '@/components/quick-open-file-list'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  outputFileName,
  resolveWorkspaceOutputPath
} from '../../../../shared/session-follow-up-deliverables'
import {
  SESSION_FOLLOW_UP_MAX_FILES,
  type SessionFollowUpDeliverables
} from '../../../../shared/session-follow-up-rule'

/** What the owner is told before consenting, and what the transcript costs. */
export type NextStepTranscriptOption = {
  included: boolean
  onToggle: (included: boolean) => void
  /** Size and message count of the redacted transcript, once it has been built. */
  preview?: { messageCount: number; sizeBytes: number } | null
  /** Why the transcript cannot be sent — the redactor's refusal, verbatim. */
  error?: string | null
  pending?: boolean
  /** One plain sentence about which delivery carries the transcript, when it matters. */
  note?: string
  /** The history cannot be captured for this handoff; the note says why. */
  disabled?: boolean
}

function formatTranscriptBytes(bytes: number): string {
  const kib = bytes / 1024
  return kib < 1024 ? `${kib.toFixed(1)} KiB` : `${(kib / 1024).toFixed(1)} MiB`
}

/**
 * The transcript is the one deliverable that can carry anything the session
 * touched, so it is off until a person ticks it and reads what it contains.
 */
export function NextStepTranscriptConsent({
  option,
  label
}: {
  option: NextStepTranscriptOption
  /** The line beside the box; the default names the transcript as such. */
  label?: string
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="space-y-1 rounded-md border border-border/60 p-2" data-next-step-transcript>
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={option.included}
          disabled={option.disabled === true}
          onCheckedChange={(checked) => option.onToggle(checked === true)}
        />
        <label htmlFor={id} className="cursor-pointer text-xs">
          {label ??
            translate('nextStep.includeTranscript', 'Include the session transcript (redacted)')}
        </label>
      </div>
      <NextStepTranscriptNotes option={option} />
    </div>
  )
}

/** What the consent box says: the delivery note, what the transcript holds, its size or refusal. */
export function NextStepTranscriptNotes({
  option
}: {
  option: NextStepTranscriptOption
}): React.JSX.Element {
  return (
    <>
      {option.note ? (
        <p className="text-[11px] text-muted-foreground" data-next-step-transcript-note>
          {option.note}
        </p>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'nextStep.includeTranscriptConsent',
          'The transcript can include file contents and command output from this session. It is redacted for secrets and sent as a file the recipient can open.'
        )}
      </p>
      {option.included && option.pending ? (
        <p className="text-[11px] text-muted-foreground" data-next-step-transcript-pending>
          {translate('nextStep.transcriptPreparing', 'Preparing the transcript…')}
        </p>
      ) : null}
      {option.included && option.preview && !option.error ? (
        <p className="text-[11px] text-muted-foreground" data-next-step-transcript-size>
          {translate(
            'nextStep.transcriptSize',
            '{{count}} messages, {{size}} — sent as one file.',
            {
              count: option.preview.messageCount,
              size: formatTranscriptBytes(option.preview.sizeBytes)
            }
          )}
        </p>
      ) : null}
      {option.included && option.error ? (
        <p role="alert" className="text-[11px] text-destructive" data-next-step-transcript-error>
          {option.error}
        </p>
      ) : null}
    </>
  )
}

/** Reuse the owning work location's file inventory and the existing delayed delivery rule. */
export function NextStepWorkFiles({
  worktreeId,
  executionHostId,
  workspacePath,
  deliverables,
  defaults,
  timing = 'finished',
  maxFiles = SESSION_FOLLOW_UP_MAX_FILES - 1,
  transcript,
  onChange
}: {
  worktreeId: string
  executionHostId?: ExecutionHostId
  workspacePath: string
  deliverables: SessionFollowUpDeliverables | null
  defaults: SessionFollowUpDeliverables | null
  timing?: 'finished' | 'dispatch'
  maxFiles?: number
  /** Absent where a transcript has no meaning (an agent step, or no session). */
  transcript?: NextStepTranscriptOption
  onChange: (deliverables: SessionFollowUpDeliverables | null) => void
}): React.JSX.Element {
  const [choosing, setChoosing] = useState(false)
  const paths = deliverables?.kind === 'files' ? deliverables.paths : []
  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-expanded={choosing}
        onClick={() => setChoosing(!choosing)}
      >
        <Paperclip className="size-3.5" />
        {translate('nextStep.addFromWorkspace', 'Add from workspace…')}
      </Button>
      {paths.length ? (
        <ul className="space-y-1">
          {paths.map((path) => (
            <li key={path} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={path}>
                {outputFileName(path)}
              </span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={translate('nextStep.removeWorkFile', 'Remove {{name}}', {
                  name: outputFileName(path)
                })}
                onClick={() =>
                  onChange({ kind: 'files', paths: paths.filter((item) => item !== path) })
                }
              >
                <X className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {deliverables?.kind === 'files' && defaults ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(defaults)}>
          {translate('nextStep.useRunFiles', 'Use the run’s final deliverables')}
        </Button>
      ) : null}
      {choosing ? (
        <WorkFileChoices
          key={`${worktreeId}:${workspacePath}`}
          worktreeId={worktreeId}
          executionHostId={executionHostId}
          workspacePath={workspacePath}
          paths={paths}
          maxFiles={maxFiles}
          timing={timing}
          onChange={(next) => onChange({ kind: 'files', paths: next })}
        />
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        {timing === 'dispatch'
          ? translate(
              'conversationFleet.workFilesTiming',
              'Selected files are captured now and included in the remote workspace.'
            )
          : translate(
              'nextStep.selectedAttachmentsTiming',
              'Selected files and folders are captured when this work finishes. Folders are sent as one archive.'
            )}
      </p>
      {transcript ? <NextStepTranscriptConsent option={transcript} /> : null}
    </div>
  )
}

function WorkFileChoices({
  worktreeId,
  executionHostId,
  workspacePath,
  paths,
  maxFiles,
  timing,
  onChange
}: {
  worktreeId: string
  executionHostId?: ExecutionHostId
  workspacePath: string
  paths: string[]
  maxFiles: number
  timing: 'finished' | 'dispatch'
  onChange: (paths: string[]) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const { files, loading, loadError, truncated } = useRuntimeFileListForWorktree({
    enabled: true,
    worktreeId,
    executionHostId,
    query
  })
  const full = paths.length >= maxFiles
  const enteredPath = resolveWorkspaceOutputPath(workspacePath, query)
  const matches = files.filter(
    (file) =>
      file.toLowerCase().includes(query.toLowerCase()) &&
      resolveWorkspaceOutputPath(workspacePath, file)
  )
  return (
    <div className="space-y-2 rounded-md border p-2">
      <Input
        aria-label={translate('nextStep.findWorkFile', 'Find a work file')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {timing === 'finished' ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={full || !enteredPath || paths.includes(enteredPath)}
          onClick={() => {
            if (enteredPath) {
              onChange([...paths, enteredPath])
              setQuery('')
            }
          }}
        >
          {translate('nextStep.addFileOrFolderPath', 'Add file or folder path')}
        </Button>
      ) : null}
      {loading ? <p>{translate('nextStep.loadingWorkFiles', 'Loading work files…')}</p> : null}
      {loadError ? (
        <p role="alert" className="text-destructive">
          {loadError}
        </p>
      ) : null}
      {!loading && !loadError ? (
        <div className="max-h-40 overflow-y-auto scrollbar-sleek">
          {matches.slice(0, 40).map((file) => {
            const path = resolveWorkspaceOutputPath(workspacePath, file)
            if (!path) {
              return null
            }
            const selected = paths.includes(path)
            return (
              <Button
                type="button"
                key={file}
                size="sm"
                variant={selected ? 'secondary' : 'ghost'}
                className="w-full justify-start truncate"
                aria-pressed={selected}
                disabled={full && !selected}
                onClick={() =>
                  onChange(selected ? paths.filter((item) => item !== path) : [...paths, path])
                }
              >
                {file}
              </Button>
            )
          })}
          {!matches.length ? (
            <p>{translate('nextStep.noWorkFiles', 'No matching work files.')}</p>
          ) : null}
        </div>
      ) : null}
      {full ? (
        <p>
          {timing === 'dispatch'
            ? translate(
                'conversationFleet.workFilesLimit',
                'Up to {{count}} work files can be selected.',
                { count: maxFiles }
              )
            : translate(
                'nextStep.attachmentLimit',
                'Up to {{count}} files or folders can be selected with these options.',
                { count: maxFiles }
              )}
        </p>
      ) : null}
      {truncated || matches.length > 40 ? (
        <p>
          {translate('nextStep.narrowWorkFiles', 'Type more of the name to find another file.')}
        </p>
      ) : null}
    </div>
  )
}
