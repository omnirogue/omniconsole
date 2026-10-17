import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { ReviewRubricPicker } from '@/components/build-review/ReviewRubricPicker'
import {
  composeReviewStepInstructions,
  parseReviewStepInstructions,
  type ReviewStepRubrics
} from '../../../../shared/review-rubrics'

/**
 * "What good means" for a judging step: a rubric from the library (or none), and anything else
 * that matters in the person's own words. Both live in the step's instruction, where the judges
 * and JEV read them; JEV scores every bulleted line on its own.
 */
export function WorkflowRubricFields({
  id,
  instruction,
  onInstruction,
  placeholder,
  hint
}: {
  id: string
  instruction: string
  onInstruction: (instruction: string) => void
  placeholder: string
  hint: string
}) {
  const parsed = parseReviewStepInstructions(instruction)
  const set = (patch: Partial<ReviewStepRubrics>) =>
    onInstruction(composeReviewStepInstructions({ ...parsed, ...patch }))
  return (
    <div className="col-span-2 flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {translate('workflowGraph.improve.goodMeans', 'What good means (optional)')}
      <ReviewRubricPicker
        id={`${id}-rubric`}
        rubric={parsed.shared}
        emptyLabel={translate('workflowGraph.rubric.none', 'No rubric: general quality')}
        onChange={(shared) => set({ shared })}
      />
      <Textarea
        rows={3}
        className="text-xs"
        aria-label={translate('workflowGraph.rubric.more', 'Anything else that matters')}
        value={parsed.focus}
        placeholder={placeholder}
        onChange={(event) => set({ focus: event.target.value })}
      />
      <span className="font-normal">{hint}</span>
    </div>
  )
}
