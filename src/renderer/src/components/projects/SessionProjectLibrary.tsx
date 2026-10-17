import React, { useMemo } from 'react'
import { FileText, GitPullRequest, Globe } from 'lucide-react'
import { useSessionDocumentSources } from '@/components/right-sidebar/session-artifact/use-session-artifacts'
import { translate } from '@/i18n/i18n'
import { openSidebarSession } from '@/lib/open-sidebar-session'
import {
  sessionProjectLibrary,
  type SessionProjectLibraryItem
} from '@/lib/session-project-library'
import type { SessionProjectThread } from '@/lib/session-project-threads'
import { useSessionProjectOutputs } from './use-session-project-review'
import { reviewStateLabel } from './session-project-status-labels'

function kindLabel(item: SessionProjectLibraryItem): string {
  switch (item.kind) {
    case 'review':
      return translate('projects.library.review', 'PR {{label}} {{state}}', {
        label: item.label,
        state: item.state ? reviewStateLabel(item.state) : ''
      }).trim()
    case 'slite':
      return translate('projects.library.slite', 'Slite doc {{label}}', { label: item.label })
    case 'artifact':
      return translate('projects.library.artifact', 'OmniOS page {{label}}', { label: item.label })
  }
}

const ICONS = { review: GitPullRequest, slite: FileText, artifact: Globe } as const

/** Everything the project's threads produced, each with the thread it came from. */
export function SessionProjectLibrary({
  folderId,
  threads
}: {
  folderId: string
  threads: readonly SessionProjectThread[]
}): React.JSX.Element {
  const outputsFor = useSessionProjectOutputs()
  const { records, linked } = useSessionDocumentSources(folderId)
  const items = useMemo(
    () => sessionProjectLibrary(threads, outputsFor, records, linked),
    [threads, outputsFor, records, linked]
  )
  return (
    <section
      aria-label={translate('projects.library.title', 'Library')}
      data-session-project-library={items.length}
      className="space-y-2"
    >
      <h2 className="text-sm font-semibold">
        {translate('projects.library.heading', 'Library {{count}}', { count: items.length })}
      </h2>
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
          {translate(
            'projects.library.empty',
            'Nothing yet. Pull requests, OmniOS pages and Slite docs the threads make or link show here.'
          )}
        </p>
      ) : (
        <ul className="space-y-px">
          {items.map((item) => {
            const Icon = ICONS[item.kind]
            return (
              <li
                key={item.key}
                data-session-project-library-item={item.kind}
                className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-xs"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <button
                  type="button"
                  className="min-w-0 truncate text-left font-medium hover:underline"
                  onClick={() => void window.api.shell.openUrl(item.url)}
                >
                  {kindLabel(item)}
                </button>
                <button
                  type="button"
                  className="ml-auto min-w-0 truncate text-muted-foreground hover:text-foreground"
                  onClick={() => openSidebarSession(item.thread.row.session)}
                >
                  {translate('projects.library.from', 'from {{thread}}', {
                    thread: item.thread.row.session.label
                  })}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
