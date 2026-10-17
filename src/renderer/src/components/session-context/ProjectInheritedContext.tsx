import { useState } from 'react'
import { Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { launchSessionContextKey, useSessionContext } from '@/lib/session-context-store'
import { resolveLaunchProject, useLaunchProject } from '@/lib/project-launch'
import { cn } from '@/lib/utils'
import { rememberedTemplateId } from '@/components/sidebar/session-folders/new-conversation/launch-context'
import type { InheritedItem } from '../../../../shared/project-launch-inheritance'
import { SessionContextFiles } from './SessionContextFiles'

/**
 * What a launch inside a project inherits (plan §8 F3/F4): each project item greyed with an "x"
 * to leave it out of this session, and anything the target computer lacks flagged "not on
 * <host>" with Drop or Replace, before the launch, so nothing is dropped silently.
 */
export function ProjectInheritedContext({
  worktreeId
}: {
  worktreeId: string | null
  /** Changes when the target's skills are read, so they re-resolve. */
  skillsLoaded?: number
}) {
  // Why subscribed but unread: the resolution reads these stores' current state; each change re-renders.
  useLaunchProject((state) => state.removed)
  useLaunchProject((state) => state.replaced)
  useLaunchProject((state) => state.folderId)
  useSessionFolders((state) => state.metadata)
  useSessionContext(launchSessionContextKey(worktreeId))
  const settings = useAppStore((state) => state.settings)
  const [replacing, setReplacing] = useState<string | null>(null)
  const resolution = resolveLaunchProject(worktreeId, rememberedTemplateId(settings, worktreeId))
  if (!resolution) {
    return null
  }
  const { project, hostLabel } = resolution
  return (
    <section
      className="min-w-0 space-y-1"
      data-project-inherited={project.folderId}
      aria-label={translate('projects.inherited.title', 'From project {{name}}', {
        name: project.name
      })}
    >
      <h4 className="text-xs font-medium">
        {translate('projects.inherited.title', 'From project {{name}}', { name: project.name })}
      </h4>
      {resolution.agent ? (
        <p className="text-xs text-muted-foreground" data-project-inherited-agent="">
          {translate('projects.inherited.agent', 'Agent: {{name}} (from the project)', {
            name: resolution.agent.name
          })}
        </p>
      ) : null}
      {resolution.inherited.length ? (
        <ul className="space-y-1">
          {resolution.inherited.map((item) => (
            <InheritedRow
              key={item.id}
              item={item}
              hostLabel={hostLabel}
              onToggle={() => useLaunchProject.getState().toggleRemoved(item.id)}
              onReplace={() => setReplacing(replacing === item.id ? null : item.id)}
              onUndoReplace={() => useLaunchProject.getState().replace(item.id, null)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {translate('projects.inherited.none', 'The project adds no files, docs or repos.')}
        </p>
      )}
      {replacing ? (
        <div className="space-y-1" data-project-inherited-replace={replacing}>
          <p className="text-xs text-muted-foreground">
            {translate('projects.inherited.pickReplacement', 'Pick a stand-in on {{host}}', {
              host: hostLabel
            })}
          </p>
          <SessionContextFiles
            worktreeId={worktreeId}
            chosen={new Set()}
            busy={false}
            onAdd={async (items) => {
              if (items[0]) {
                useLaunchProject.getState().replace(replacing, items[0])
                setReplacing(null)
              }
            }}
            onError={() => undefined}
          />
        </div>
      ) : null}
      {resolution.error ? (
        <p role="alert" className="text-xs text-destructive">
          {resolution.error}
        </p>
      ) : null}
    </section>
  )
}

function InheritedRow({
  item,
  hostLabel,
  onToggle,
  onReplace,
  onUndoReplace
}: {
  item: InheritedItem
  hostLabel: string
  onToggle: () => void
  onReplace: () => void
  onUndoReplace: () => void
}) {
  const missing = item.state === 'not-on-host'
  return (
    <li
      data-project-inherited-item={item.id}
      data-project-inherited-state={item.state}
      className={cn(
        'flex min-w-0 items-center gap-2 rounded border px-2 py-1 text-xs',
        missing
          ? 'border-status-warning-border bg-status-warning-background'
          : 'text-muted-foreground'
      )}
    >
      <span className={cn('min-w-0 flex-1 truncate', item.state === 'removed' && 'line-through')}>
        {item.title}
      </span>
      <span className={cn('shrink-0', missing && 'text-status-warning')}>
        {missing
          ? translate('projects.inherited.notOnHost', 'not on {{host}}', { host: hostLabel })
          : item.state === 'unverified'
            ? translate('projects.inherited.unverified', "can't check on {{host}}", {
                host: hostLabel
              })
            : item.state === 'replaced'
              ? translate('projects.inherited.replaced', 'replaced')
              : item.repo
                ? translate('projects.inherited.fromRepo', 'from {{repo}}', { repo: item.repo })
                : item.kind}
      </span>
      {missing ? (
        <>
          <Button type="button" variant="ghost" size="xs" onClick={onToggle}>
            {translate('projects.inherited.drop', 'Drop')}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={onReplace}>
            {translate('projects.inherited.replace', 'Replace')}
          </Button>
        </>
      ) : item.state === 'removed' || item.state === 'replaced' ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate('projects.inherited.restore', 'Put back {{title}}', {
            title: item.title
          })}
          onClick={item.state === 'removed' ? onToggle : onUndoReplace}
        >
          <Undo2 className="size-3" />
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate('projects.inherited.leaveOut', 'Leave {{title}} out', {
            title: item.title
          })}
          onClick={onToggle}
        >
          <X className="size-3" />
        </Button>
      )}
    </li>
  )
}
