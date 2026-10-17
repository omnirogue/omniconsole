import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  NEXT_STEP_TEMPLATE_IDS,
  type NextStepTemplateId
} from '../../../../shared/next-step-templates'

export function templateLabel(id: NextStepTemplateId): string {
  switch (id) {
    case 'research-plan':
      return translate('nextStep.templateResearchPlan', '🔬 Research → 📝 Plan')
    case 'research-plan-create':
      return translate('nextStep.templateResearchPlanCreate', '🔬 Research → 📝 Plan → 🛠 Create')
    case 'council':
      return translate('nextStep.templateCouncil', '👀👀👀 The Council → 🧩 Synthesize')
    case 'compare-answers':
      return translate('nextStep.templateCompare', '🤖🤖🤖 Compare answers → 🧩 Synthesize')
    case 'best-of-n':
      return translate('nextStep.templateBestOfN', '🤖🤖 Best of N → 👀 Judge → 🧩 Pick the best')
  }
}

export function NextStepTemplateMenu({
  onSelect
}: {
  onSelect: (id: NextStepTemplateId) => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="xs" data-next-step-templates>
          {translate('nextStep.templates', 'Templates')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {NEXT_STEP_TEMPLATE_IDS.map((id) => (
          <DropdownMenuItem key={id} onSelect={() => onSelect(id)}>
            {templateLabel(id)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
