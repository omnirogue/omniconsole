import { ClipboardCheck } from 'lucide-react'
import { openWorkDecisions } from '@/lib/open-work-decisions'
import { translate } from '@/i18n/i18n'
import { SidebarNavMemberButton } from './SidebarNavMemberButton'

export function DecisionsSidebarEntry(): React.JSX.Element {
  return (
    <SidebarNavMemberButton
      icon={ClipboardCheck}
      active={false}
      label={translate('nav.decisions', 'Decisions')}
      onClick={openWorkDecisions}
    />
  )
}
