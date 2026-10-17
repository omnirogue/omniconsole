import React from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Toggle } from '@/components/ui/toggle'
import { translate } from '@/i18n/i18n'
import { launchHostLabel } from '@/lib/project-launch'
import {
  SESSION_PROJECT_STATUS_ORDER,
  type SessionProjectThreadGroupKey
} from '@/lib/session-project-thread-groups'
import {
  sessionProjectThreadModelFamily,
  type SessionProjectThread
} from '@/lib/session-project-threads'
import {
  emptySessionProjectViewState,
  isSessionProjectViewFiltered,
  type SessionProjectViewState
} from '@/lib/session-project-view-state'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ModelLineage } from '../../../../shared/model-lineage'
import { sessionProjectThreadGroupLabel } from './session-project-status-labels'

const NO_ISSUE = 'none'

const MODEL_FAMILY_LABELS: Partial<Record<ModelLineage, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
  google: 'Google',
  moonshot: 'Moonshot',
  alibaba: 'Alibaba',
  deepseek: 'DeepSeek',
  meta: 'Meta',
  mistral: 'Mistral'
}

export function modelFamilyLabel(family: ModelLineage): string {
  return MODEL_FAMILY_LABELS[family] ?? family.charAt(0).toUpperCase() + family.slice(1)
}

function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function Chip({
  pressed,
  onPressedChange,
  label,
  count,
  filter
}: {
  pressed: boolean
  onPressedChange: () => void
  label: string
  count?: number
  filter: string
}): React.JSX.Element {
  return (
    <Toggle
      size="sm"
      variant="outline"
      pressed={pressed}
      onPressedChange={onPressedChange}
      data-session-project-filter={filter}
      className="h-7 gap-1 rounded-full px-2.5 text-xs data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
    >
      {label}
      {count !== undefined ? (
        <span className="tabular-nums text-muted-foreground" data-session-project-filter-count="">
          {count}
        </span>
      ) : null}
    </Toggle>
  )
}

function ChipGroup({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      <span className="text-muted-foreground">{label}</span>
      {children}
    </span>
  )
}

function toggled<T extends string>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]
}

/**
 * The page's filters: the status buckets with their counts, then whichever of agent, model family,
 * computer and issue has more than one value among the project's threads. Bound to the per-device
 * view state, so a project reopens the way it was left.
 */
export function SessionProjectFilterBar({
  threads,
  counts,
  archivedCount,
  state,
  onChange
}: {
  /** Every thread of the project, archived ones included; the chips are computed from them. */
  threads: readonly SessionProjectThread[]
  counts: Record<SessionProjectThreadGroupKey, number>
  archivedCount: number
  state: SessionProjectViewState
  onChange: (patch: Partial<SessionProjectViewState>) => void
}): React.JSX.Element {
  const agents = distinct(threads.map((thread) => thread.agent)).sort()
  const families = distinct(threads.map(sessionProjectThreadModelFamily)).sort()
  const hosts = distinct(threads.map((thread) => thread.host ?? 'local'))
  const issues = distinct(threads.flatMap((thread) => (thread.jira ? [thread.jira.issue_key] : [])))
  const hasThreadWithoutIssue = issues.length > 0 && threads.some((thread) => !thread.jira)
  const filtered = isSessionProjectViewFiltered(state)
  const facets = agents.length > 1 || families.length > 1 || hosts.length > 1 || issues.length > 0
  return (
    <section
      aria-label={translate('projects.filter.label', 'Filter threads')}
      data-session-project-filters=""
      className="space-y-2"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          type="search"
          value={state.search}
          onChange={(event) => onChange({ search: event.target.value })}
          placeholder={translate('projects.filter.search', 'Search threads')}
          aria-label={translate('projects.filter.search', 'Search threads')}
          className="h-7 w-44 text-xs"
          data-session-project-search=""
        />
        {SESSION_PROJECT_STATUS_ORDER.map((status) =>
          counts[status] > 0 || state.statuses.includes(status) ? (
            <Chip
              key={status}
              pressed={state.statuses.includes(status)}
              onPressedChange={() => onChange({ statuses: toggled(state.statuses, status) })}
              label={sessionProjectThreadGroupLabel(status)}
              count={counts[status]}
              filter={`status:${status}`}
            />
          ) : null
        )}
        {archivedCount > 0 || state.includeArchived ? (
          <Chip
            pressed={state.includeArchived}
            onPressedChange={() => onChange({ includeArchived: !state.includeArchived })}
            label={translate('projects.filter.archived', 'Archived')}
            count={archivedCount}
            filter="archived"
          />
        ) : null}
        {filtered ? (
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() =>
              onChange({
                ...emptySessionProjectViewState(),
                includeArchived: state.includeArchived
              })
            }
            data-session-project-filter-clear=""
          >
            <X className="size-3" aria-hidden />
            {translate('projects.filter.clear', 'Clear')}
          </Button>
        ) : null}
      </div>
      {facets ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          {agents.length > 1 ? (
            <ChipGroup label={translate('projects.filter.agent', 'Agent')}>
              {agents.map((agent) => (
                <Chip
                  key={agent}
                  pressed={state.agents.includes(agent)}
                  onPressedChange={() => onChange({ agents: toggled(state.agents, agent) })}
                  label={agent}
                  filter={`agent:${agent}`}
                />
              ))}
            </ChipGroup>
          ) : null}
          {families.length > 1 ? (
            <ChipGroup label={translate('projects.filter.model', 'Model')}>
              {families.map((family) => (
                <Chip
                  key={family}
                  pressed={state.modelFamilies.includes(family)}
                  onPressedChange={() =>
                    onChange({ modelFamilies: toggled(state.modelFamilies, family) })
                  }
                  label={modelFamilyLabel(family)}
                  filter={`model:${family}`}
                />
              ))}
            </ChipGroup>
          ) : null}
          {hosts.length > 1 ? (
            <ChipGroup label={translate('projects.filter.computer', 'Computer')}>
              {hosts.map((host) => (
                <Chip
                  key={host}
                  pressed={state.hosts.includes(host)}
                  onPressedChange={() => onChange({ hosts: toggled(state.hosts, host) })}
                  label={launchHostLabel(host as ExecutionHostId)}
                  filter={`host:${host}`}
                />
              ))}
            </ChipGroup>
          ) : null}
          {issues.length > 0 ? (
            <ChipGroup label={translate('projects.filter.issue', 'Issue')}>
              {issues.map((issue) => (
                <Chip
                  key={issue}
                  pressed={state.tasks.includes(issue)}
                  onPressedChange={() => onChange({ tasks: toggled(state.tasks, issue) })}
                  label={issue}
                  filter={`issue:${issue}`}
                />
              ))}
              {hasThreadWithoutIssue ? (
                <Chip
                  pressed={state.tasks.includes(NO_ISSUE)}
                  onPressedChange={() => onChange({ tasks: toggled(state.tasks, NO_ISSUE) })}
                  label={translate('projects.filter.noIssue', 'No issue')}
                  filter={`issue:${NO_ISSUE}`}
                />
              ) : null}
            </ChipGroup>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
