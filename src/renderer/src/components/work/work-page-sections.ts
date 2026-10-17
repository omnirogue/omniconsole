import { translate } from '@/i18n/i18n'

/** The Work home order also supplies the command-center content menu. */
export const WORK_PAGE_SECTIONS = [
  { id: 'dispatch', label: () => translate('commandCenter.content.section.dispatch', 'Dispatch') },
  { id: 'projects', label: () => translate('commandCenter.content.section.projects', 'Projects') },
  {
    id: 'needs-you',
    label: () => translate('commandCenter.content.section.needs-you', 'Needs you')
  },
  {
    id: 'happening',
    label: () => translate('commandCenter.content.section.happening', "What's happening")
  },
  {
    id: 'steward',
    label: () => translate('commandCenter.content.section.steward', 'Steward activity')
  },
  {
    id: 'cleanup',
    label: () => translate('commandCenter.content.section.cleanup', 'Cleanup runs')
  },
  {
    id: 'other-computers',
    label: () => translate('commandCenter.content.section.other-computers', 'Other computers')
  },
  {
    id: 'companies',
    label: () => translate('commandCenter.content.section.companies', 'Companies')
  },
  { id: 'stats', label: () => translate('commandCenter.content.section.stats', 'Stats') }
] as const
