import { useMemo } from 'react'
import { useWorkFolders, useWorkFoldersScope } from '@/components/companies/use-work-folders'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { sessionPlaceKey } from '@/lib/session-place-choice'
import { cn } from '@/lib/utils'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionPlace, useSessionPlaces } from '@/store/session-place-store'
import {
  nextStepPlaceLabel,
  nextStepPlaceOptions,
  placeChoiceFromCompanyPlace
} from './next-step-place-options'
import { useNextStepPlace } from './use-next-step-place'

/**
 * Company → department, chosen in place. The folder the workspace sits in is the default;
 * a choice made here is remembered for this conversation and files its cards.
 */
export function NextStepPlaceSelect({
  session,
  flat = false
}: {
  session: SidebarSession
  /** Reads as one muted line among the session facts; the click still opens the select. */
  flat?: boolean
}): React.JSX.Element {
  const folders = useWorkFolders(useWorkFoldersScope())
  const derived = useNextStepPlace(session.worktreeId)
  const sourceKey = sidebarSessionSourceIdentity(session)?.sourceKey ?? null
  const chosen = useSessionPlace(sourceKey)
  const setPlace = useSessionPlaces((state) => state.setPlace)
  const companies = folders.data?.companies
  const options = useMemo(() => nextStepPlaceOptions(companies ?? []), [companies])
  const folderPlace = derived.phase === 'ready' ? placeChoiceFromCompanyPlace(derived.place) : null
  const current = chosen ?? folderPlace
  const value = current ? sessionPlaceKey(current) : ''
  const known = options.some((option) => option.value === value)
  const placeholder = current
    ? nextStepPlaceLabel(current)
    : derived.phase === 'loading'
      ? translate('nextStep.placeLoading', 'Reading where this work is filed…')
      : derived.phase === 'error'
        ? translate('nextStep.placeUnavailable', 'Could not read: {{message}}', {
            message: derived.message
          })
        : derived.place
          ? translate('nextStep.placeChooseDepartment', '{{company}} · choose a department', {
              company: derived.place.company.name
            })
          : translate('nextStep.placeChoose', 'Choose company → domain')
  return (
    <div className="flex min-w-0 items-center gap-1" data-next-step-place={value}>
      <Select
        value={known ? value : ''}
        disabled={!sourceKey || options.length === 0}
        onValueChange={(next) => {
          const option = options.find((entry) => entry.value === next)
          if (option && sourceKey) {
            setPlace(sourceKey, option.choice)
          }
        }}
      >
        <SelectTrigger
          size="sm"
          className={cn(
            'h-7 min-w-0 flex-1 text-xs',
            flat &&
              'h-6 gap-1 border-0 bg-transparent px-0 text-muted-foreground shadow-none hover:text-foreground dark:bg-transparent dark:hover:bg-transparent'
          )}
          aria-label={translate('nextStep.companyDomain', 'Company / Domain')}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {chosen && sourceKey ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          title={folderPlace ? nextStepPlaceLabel(folderPlace) : undefined}
          onClick={() => setPlace(sourceKey, null)}
        >
          {translate('nextStep.useFolderPlace', 'Use folder’s')}
        </Button>
      ) : null}
    </div>
  )
}
