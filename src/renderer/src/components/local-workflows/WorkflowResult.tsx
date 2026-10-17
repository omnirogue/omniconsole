import type { ReactNode } from 'react'
import { Download, MessageSquarePlus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { WorkflowMarkdown } from './WorkflowMarkdown'
import { NativeChatCopyButton } from '../native-chat/NativeChatCopyButton'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import { formatWorkflowTokens } from './local-workflow-labels'

/**
 * What the run used, in tokens, when the host knows it: total, then input and output. Never a
 * price: the providers bill by plan and account, which the host does not see.
 */
export function WorkflowUsageLine({ usage }: { usage: LocalWorkflowView['usage'] }) {
  const tokens = usage?.tokens
  if (!tokens || tokens.input + tokens.output <= 0) {
    return null
  }
  const values = {
    total: formatWorkflowTokens(tokens.input + tokens.output),
    input: formatWorkflowTokens(tokens.input),
    output: formatWorkflowTokens(tokens.output)
  }
  return (
    <p className="font-mono text-[11px] text-muted-foreground" data-workflow-usage={tokens.kind}>
      {tokens.kind === 'estimated'
        ? translate(
            'localWorkflow.run.usageEstimated',
            'About {{total}} tokens used (estimated) · {{input}} in · {{output}} out',
            values
          )
        : translate(
            'localWorkflow.run.usage',
            '{{total}} tokens used · {{input}} in · {{output}} out',
            values
          )}
    </p>
  )
}

/** Copy · Save as file · Ask a follow-up · New question, under the final answer or report. */
export function WorkflowResultActions({
  markdown,
  disabled,
  savedPath,
  followUpOpen,
  newTurnLabel,
  onSave,
  onToggleFollowUp,
  onNewTurn
}: {
  markdown: string
  disabled: boolean
  savedPath?: string
  followUpOpen: boolean
  newTurnLabel: string
  onSave?: () => void
  onToggleFollowUp?: () => void
  onNewTurn?: () => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <NativeChatCopyButton
          text={markdown}
          label={translate('localWorkflow.run.copyAnswer', 'Copy answer')}
        />
        {onSave && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={disabled}
            onClick={onSave}
          >
            <Download aria-hidden="true" className="size-3.5" />
            {translate('localWorkflow.run.saveAsFile', 'Save as file…')}
          </Button>
        )}
        {onToggleFollowUp && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-expanded={followUpOpen}
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={disabled}
            onClick={onToggleFollowUp}
          >
            <MessageSquarePlus aria-hidden="true" className="size-3.5" />
            {translate('localWorkflow.run.askFollowUp', 'Ask a follow-up')}
          </Button>
        )}
        {onNewTurn && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={disabled}
            onClick={onNewTurn}
          >
            <Plus aria-hidden="true" className="size-3.5" />
            {newTurnLabel}
          </Button>
        )}
      </div>
      {savedPath ? (
        <p role="status" className="break-all text-xs text-muted-foreground">
          {translate('localWorkflow.run.savedTo', 'Saved to {{path}}', { path: savedPath })}
        </p>
      ) : null}
    </div>
  )
}

/** The final answer for runs without a preset-specific view (older revisions). */
export function WorkflowFinalCard({
  title,
  markdown,
  appendix,
  highlighted,
  footer
}: {
  title: string
  markdown: string
  /** The app's own part of a run that reads pages; rendered apart, so the answer cannot hide it. */
  appendix?: string
  highlighted: boolean
  footer?: ReactNode
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        'space-y-3 rounded-xl border bg-card p-4',
        highlighted && 'border-status-success-border'
      )}
    >
      <h4 className="text-sm font-medium">{title}</h4>
      <WorkflowMarkdown className="text-[15px] leading-7" content={markdown} />
      {appendix ? (
        <section
          aria-label={translate('localWorkflow.webChecks.appendix', 'The app’s own checks')}
          className="rounded-lg border border-dashed p-3"
          data-workflow-result-appendix=""
        >
          <WorkflowMarkdown className="text-sm" content={appendix} />
        </section>
      ) : null}
      {footer}
    </section>
  )
}
