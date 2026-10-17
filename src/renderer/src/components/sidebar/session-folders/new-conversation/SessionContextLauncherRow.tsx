import { Paperclip } from 'lucide-react'
import { useRef } from 'react'
import { SessionContextEditor } from '@/components/session-context/SessionContextEditor'
import { ProjectInheritedContext } from '@/components/session-context/ProjectInheritedContext'
import { LaunchContextKeepToggle } from '@/components/session-context/LaunchContextKeepToggle'
import {
  resolveLaunchProject,
  useActiveLaunchProject,
  useLaunchProject
} from '@/lib/project-launch'
import { launchSessionContextKey, useSessionContext } from '@/lib/session-context-store'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { rememberedTemplateId } from './launch-context'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { HoverOpenContentProps } from '@/components/next-step/use-hover-open-popover'

export function SessionContextLauncherRow({
  hover,
  worktreeId
}: {
  hover: HoverOpenContentProps
  worktreeId: string | null
}) {
  const triggerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const contextKey = launchSessionContextKey(worktreeId)
  const attachments = useSessionContext(contextKey)
  const project = useActiveLaunchProject()
  // Why subscribed: unticking or replacing a project item changes what the next launch attaches.
  useLaunchProject((state) => state.removed)
  useLaunchProject((state) => state.replaced)
  const settings = useAppStore((state) => state.settings)
  // Why resolved: the badge counts only what the next launch attaches; a one-shot clear drops it.
  const templateId = rememberedTemplateId(settings, worktreeId)
  const resolved = project ? resolveLaunchProject(worktreeId, templateId) : null
  const attached = resolved ? resolved.attachments.length : attachments.length
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        ref={triggerRef}
        onPointerLeave={(event) => {
          // Keep the parent menu from stealing focus as the pointer enters this form.
          if (
            event.relatedTarget instanceof Node &&
            contentRef.current?.contains(event.relatedTarget)
          ) {
            event.preventDefault()
          }
        }}
      >
        <Paperclip className="size-3.5" />
        <span className="min-w-0 flex-1 truncate" data-launcher-project={project?.folderId}>
          {project
            ? translate('projects.launcher.row', 'Project: {{name}}', { name: project.name })
            : translate('sessionContext.title', 'Session context')}
        </span>
        {!!attached && <Badge variant="secondary">{attached}</Badge>}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        ref={contentRef}
        onFocusOutside={(event) => {
          // Pointer-leave can focus the parent container even while entering the form.
          if (event.target === triggerRef.current?.closest('[role="menu"]')) {
            event.preventDefault()
          }
        }}
        className="w-[420px] max-w-[90vw] max-h-[70vh] overflow-y-auto p-3 scrollbar-sleek"
        onPointerMove={hover.onPointerMove}
        onPointerEnter={hover.onPointerEnter}
        onPointerLeave={hover.onPointerLeave}
        onPointerDownCapture={hover.onPointerDownCapture}
      >
        <div
          onKeyDown={(event) => {
            if (event.key !== 'Escape') {
              event.stopPropagation()
            }
          }}
        >
          {project ? (
            <div className="mb-3">
              <ProjectInheritedContext worktreeId={worktreeId} />
            </div>
          ) : null}
          <SessionContextEditor key={contextKey} contextKey={contextKey} worktreeId={worktreeId} />
          <LaunchContextKeepToggle contextKey={contextKey} />
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
