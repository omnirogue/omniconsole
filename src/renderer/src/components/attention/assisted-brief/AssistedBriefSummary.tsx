import React from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  isPersonOrigin,
  splitBriefLines,
  type BriefLine
} from '../../../../../shared/assisted-brief-revisions'
import {
  BRIEF_LIST_SECTIONS,
  type AssistedBriefRecord,
  type BriefContent
} from '../../../../../shared/assisted-brief-types'
import { briefProposalLabel, briefSectionLabel } from './assisted-brief-labels'

const CAPTION = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'
const ORIGIN_PILL =
  'mr-1.5 rounded-full bg-muted px-1.5 text-[10px] font-normal leading-4 text-muted-foreground'

function RequirementGroups({ lines }: { lines: BriefLine[] }): React.JSX.Element {
  return (
    <>
      {BRIEF_LIST_SECTIONS.map((section) => {
        const items = lines.filter((line) => line.section === section)
        return items.length > 0 ? (
          <div key={section} className="space-y-0.5">
            <p className={CAPTION}>{briefSectionLabel(section)}</p>
            <ul className="list-disc space-y-0.5 pl-4 text-sm">
              {items.map(({ item }) => (
                <li key={item.id}>
                  {item.text}
                  {item.origin === 'answer' ? (
                    <span className="ml-1 text-[11px] text-muted-foreground">
                      {translate('assistedBrief.fromYourAnswer', '(your answer)')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null
      })}
    </>
  )
}

function ProposalRow({
  line,
  disabled,
  onRemove
}: {
  line: BriefLine
  disabled: boolean
  onRemove: (itemId: string) => void
}): React.JSX.Element {
  const removeLabel = translate('assistedBrief.removeLine', 'Remove this line')
  return (
    <li className="flex items-start gap-2 rounded-md border border-border px-2 py-1 text-sm">
      <span className="min-w-0 flex-1">
        <span className={ORIGIN_PILL}>{briefProposalLabel(line.item.origin)}</span>
        {line.item.text}
        <span className="ml-1 text-[11px] text-muted-foreground">
          · {briefSectionLabel(line.section)}
        </span>
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            aria-label={removeLabel}
            onClick={() => onRemove(line.item.id)}
          >
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {removeLabel}
        </TooltipContent>
      </Tooltip>
    </li>
  )
}

/** Plain-language brief: the person's requirements first, AI proposals apart and removable. */
export function AssistedBriefSummary({
  record,
  content,
  disabled,
  onRemove
}: {
  record: AssistedBriefRecord
  content: BriefContent
  disabled: boolean
  onRemove: (itemId: string) => void
}): React.JSX.Element {
  const { requirements, proposals } = splitBriefLines(content)
  return (
    <div className="space-y-3">
      <section className="space-y-1">
        <p className={CAPTION}>{translate('assistedBrief.outcome', 'Outcome')}</p>
        <p className="text-sm font-medium text-foreground" data-brief-outcome="">
          {isPersonOrigin(content.outcome.origin) ? null : (
            <span className={ORIGIN_PILL}>
              {translate('assistedBrief.outcomeAiWording', 'AI wording')}
            </span>
          )}
          {content.outcome.text}
        </p>
        {record.namedModels.length > 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {translate('assistedBrief.namedModels', 'Models you named, kept exactly: {{models}}', {
              models: record.namedModels.join(', ')
            })}
          </p>
        ) : null}
      </section>
      <section className="space-y-2" data-brief-requirements="">
        <h3 className="text-xs font-medium text-foreground">
          {translate('assistedBrief.yourRequirements', 'Your requirements')}
        </h3>
        {requirements.length > 0 ? (
          <RequirementGroups lines={requirements} />
        ) : (
          <p className="text-xs text-muted-foreground">
            {translate('assistedBrief.noRequirements', 'Only the outcome so far.')}
          </p>
        )}
      </section>
      {proposals.length > 0 ? (
        <section className="space-y-1.5" data-brief-proposals="">
          <h3 className="text-xs font-medium text-foreground">
            {translate('assistedBrief.aiProposals', 'AI suggestions and assumptions')}
          </h3>
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'assistedBrief.aiProposalsHelp',
              'Kept lines reach the session labelled as AI suggestions, not as your requirements. Remove any you do not want.'
            )}
          </p>
          <ul className="space-y-1">
            {proposals.map((line) => (
              <ProposalRow key={line.item.id} line={line} disabled={disabled} onRemove={onRemove} />
            ))}
          </ul>
        </section>
      ) : null}
      <details className="rounded-md border border-border px-2 py-1.5">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {translate('assistedBrief.yourWords', 'Your original request')}
        </summary>
        <p className="mt-1 whitespace-pre-wrap text-sm">{record.original.text}</p>
        {record.original.attachments.map((file) => (
          <p key={file.path} className="truncate font-mono text-[11px] text-muted-foreground">
            {file.path}
          </p>
        ))}
      </details>
    </div>
  )
}
