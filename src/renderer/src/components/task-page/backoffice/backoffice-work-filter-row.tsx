import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import {
  ALL_FILTER_VALUE,
  personName,
  WORK_QUERY_MAX,
  type WorkFilter,
  type WorkSourceFilter,
  type WorkStatusFilter
} from './backoffice-work-labels'

function FilterSelect({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="h-7 w-auto min-w-28 text-xs" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * A source change; only task rows carry a project, so a project kept while the source
 * widens would silently drop every request, follow-up and decision from the list.
 */
export function withWorkSource(filter: WorkFilter, source: WorkSourceFilter): WorkFilter {
  return { ...filter, source, project: source === 'task' ? filter.project : ALL_FILTER_VALUE }
}

/**
 * The controls that narrow a work list: search and source on every lens; person and status
 * only where the whole list is shown, since the other lenses already decide status; project
 * only over tasks, the one source whose rows carry one.
 */
export function BackofficeWorkFilterRow({
  filter,
  choices,
  names,
  allControls,
  includeTasks = true,
  onChange
}: {
  filter: WorkFilter
  choices: { people: string[]; projects: string[] }
  names: ReadonlyMap<string, string>
  /** Person, status and project too (the All tab). */
  allControls: boolean
  includeTasks?: boolean
  onChange: (filter: WorkFilter) => void
}): React.JSX.Element {
  const searchLabel = translate('backofficeWork.searchWork', 'Search work')
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={filter.query}
          maxLength={WORK_QUERY_MAX}
          aria-label={searchLabel}
          placeholder={searchLabel}
          className="h-7 w-48 pl-7 text-xs"
          onChange={(event) =>
            onChange({ ...filter, query: event.target.value.slice(0, WORK_QUERY_MAX) })
          }
        />
      </div>
      <FilterSelect
        label={translate('backofficeWork.filterSource', 'Source')}
        value={filter.source}
        onChange={(source) => onChange(withWorkSource(filter, source as WorkSourceFilter))}
        options={[
          { value: 'all', label: translate('backofficeWork.sourceAll', 'All sources') },
          ...(includeTasks
            ? [{ value: 'task', label: translate('backofficeWork.sourceTasks', 'Tasks') }]
            : []),
          {
            value: 'received',
            label: translate('backofficeWork.sourceReceived', 'Requests I received')
          },
          { value: 'sent', label: translate('backofficeWork.sourceSent', 'Requests I sent') }
        ]}
      />
      {allControls ? (
        <>
          <FilterSelect
            label={translate('backofficeWork.filterPerson', 'Person')}
            value={filter.person}
            onChange={(person) => onChange({ ...filter, person })}
            options={[
              {
                value: ALL_FILTER_VALUE,
                label: translate('backofficeWork.filterAnyone', 'Anyone')
              },
              ...choices.people.map((id) => ({ value: id, label: personName(id, names) }))
            ]}
          />
          <FilterSelect
            label={translate('backofficeWork.filterStatus', 'Status')}
            value={filter.status}
            onChange={(status) => onChange({ ...filter, status: status as WorkStatusFilter })}
            options={[
              { value: 'all', label: translate('backofficeWork.filterAnyStatus', 'Any status') },
              { value: 'needs-you', label: translate('backofficeWork.tabNeedsYou', 'Needs You') },
              { value: 'waiting', label: translate('backofficeWork.tabWaitingFor', 'Waiting For') },
              { value: 'replied', label: translate('backofficeWork.filterReplied', 'Replied') },
              { value: 'other', label: translate('backofficeWork.filterOther', 'Other open work') },
              {
                value: 'finished',
                label: translate('backofficeWork.filterFinished', 'Done and history')
              }
            ]}
          />
          {filter.source === 'task' ? (
            <FilterSelect
              label={translate('backofficeWork.filterProject', 'Project')}
              value={filter.project}
              onChange={(project) => onChange({ ...filter, project })}
              options={[
                {
                  value: ALL_FILTER_VALUE,
                  label: translate('backofficeWork.filterAllProjects', 'All projects')
                },
                ...choices.projects.map((slug) => ({ value: slug, label: slug }))
              ]}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}
