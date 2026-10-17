import { useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { LocalWorkflowDraft } from '../../../../shared/local-workflow-draft'
import {
  workflowContextAddSources,
  workflowContextSourceKey,
  type WorkflowContextSource
} from '../../../../shared/workflow-context-sources'
import {
  workflowContextChoice,
  workflowContextIncludesWorkspace
} from '../../../../shared/workflow-context-start'
import { WorkflowSelect } from './workflow-graph-controls'
import { WorkflowContextGitHubSearch } from './WorkflowContextGitHubSearch'
import { WorkflowContextLocalSearch } from './WorkflowContextLocalSearch'
import { workflowContextLocalRoots } from './workflow-context-roots'

/**
 * What agents may read: found from the description (the workspace plus what the task names, the
 * default), only chosen files, folders and repos, or no files at all. Choosing opens a picker
 * that searches this computer and GitHub; everything chosen stays removable.
 */
export function WorkflowContextAccess({
  worktreeId,
  draft,
  onChange,
  onRemove
}: {
  worktreeId: string
  draft: LocalWorkflowDraft
  onChange: (draft: LocalWorkflowDraft) => void
  onRemove: (source: WorkflowContextSource) => void
}) {
  const [open, setOpen] = useState(false)
  const selectRef = useRef<HTMLSpanElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Set while the access select closes after "Chosen files…" opened the picker.
  const reopening = useRef(false)
  const choice = workflowContextChoice(draft)
  const sources = useMemo(() => draft.contextSources ?? [], [draft.contextSources])
  const chosen = useMemo(() => new Set(sources.map(workflowContextSourceKey)), [sources])
  const includesWorkspace = workflowContextIncludesWorkspace(draft)
  const { repos, worktreesByRepo } = useAppStore(
    useShallow((state) => ({ repos: state.repos, worktreesByRepo: state.worktreesByRepo }))
  )
  const roots = useMemo(
    () => workflowContextLocalRoots(repos, worktreesByRepo),
    [repos, worktreesByRepo]
  )
  const add = (added: WorkflowContextSource[]) =>
    onChange({ ...draft, contextSources: workflowContextAddSources(sources, added) })
  const toggle = (source: WorkflowContextSource) =>
    chosen.has(workflowContextSourceKey(source)) ? onRemove(source) : add([source])
  return (
    <>
      <span ref={selectRef} className="contents">
        <WorkflowSelect
          className="w-60"
          value={choice}
          options={[
            {
              value: 'auto',
              label: translate('workflowGraph.context.auto', 'Find it from my description')
            },
            {
              value: 'sources',
              label: sources.length
                ? translate(
                    'workflowGraph.context.sourcesCount',
                    'Chosen files, folders and repos ({{count}})',
                    { count: sources.length }
                  )
                : translate('workflowGraph.context.sources', 'Chosen files, folders and repos')
            },
            {
              value: 'frozen',
              label: translate('workflowGraph.setup.knowledgeOnly', 'Knowledge only · no files')
            }
          ]}
          onChange={(next) => {
            // Auto always reads the workspace; only chosen sources may leave it out.
            const { includeWorkspace, ...rest } = draft
            onChange({
              ...rest,
              access: next as LocalWorkflowDraft['access'],
              ...(next === 'sources' && includeWorkspace !== undefined ? { includeWorkspace } : {})
            })
            if (next === 'sources') {
              reopening.current = true
              window.setTimeout(() => {
                reopening.current = false
              }, 1000)
            }
            setOpen(next === 'sources')
          }}
        />
      </span>
      {choice !== 'frozen' && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="h-8 gap-1 text-xs">
              <FolderPlus aria-hidden="true" className="size-3.5" />
              {translate('workflowGraph.context.choose', 'Add files or repos')}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            ref={contentRef}
            align="start"
            className="popover-wheel-scroll flex max-h-[min(38rem,var(--radix-popover-content-available-height))] w-[34rem] max-w-[calc(100vw-2rem)] flex-col p-0"
            onFocusOutside={(event) => {
              // Why: the select hands focus back to its trigger after its close animation, once
              // the picker is already open; that is not the person leaving the picker.
              if (reopening.current && selectRef.current?.contains(event.target as Node)) {
                reopening.current = false
                event.preventDefault()
                requestAnimationFrame(() => contentRef.current?.focus())
              }
            }}
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 scrollbar-sleek">
              {choice === 'sources' && (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="workflow-context-workspace"
                    checked={includesWorkspace}
                    onCheckedChange={(checked) =>
                      onChange({ ...draft, access: 'sources', includeWorkspace: checked === true })
                    }
                  />
                  <Label htmlFor="workflow-context-workspace" className="text-xs font-normal">
                    {translate('workflowGraph.context.includeWorkspace', 'Include this workspace')}
                  </Label>
                </div>
              )}
              <WorkflowContextLocalSearch
                worktreeId={worktreeId}
                roots={roots}
                chosen={chosen}
                onToggle={toggle}
                onAdd={add}
              />
              <WorkflowContextGitHubSearch
                roots={roots}
                chosen={chosen}
                onAdd={(source) => add([source])}
              />
              <p className="text-xs text-muted-foreground">
                {translate(
                  'workflowGraph.context.protected',
                  'Agents read private copies. Your home folder, logins, keys and .env files are never copied.'
                )}
              </p>
            </div>
            <div className="flex shrink-0 items-center justify-between gap-2 border-t p-3">
              <span role="status" className="text-xs text-muted-foreground">
                {translate('workflowGraph.context.selectedCount', '{{count}} sources selected', {
                  count: sources.length
                })}
              </span>
              <Button type="button" size="sm" onClick={() => setOpen(false)}>
                {translate('workflowGraph.context.continue', 'Continue')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </>
  )
}
