import { getCheckStatusLabel } from '@/components/github/pr-check-presentation'
import { getCheckConclusion } from '@/components/pr-check-counts'
import { CHECK_COLOR } from '@/components/right-sidebar/checks-panel/check-presentation'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { PRCheckDetail } from '../../../../shared/github/check-types'

export function NativeChatCheckPreview({ checks }: { checks: PRCheckDetail[] }): React.JSX.Element {
  return (
    <div className="space-y-1 rounded-md border border-border p-2 text-xs">
      <p className="font-medium text-foreground">
        {translate('components.native-chat.tool.reportedChecks', 'Reported checks ({{count}})', {
          count: checks.length
        })}
      </p>
      <p className="text-muted-foreground">
        {translate(
          'components.native-chat.tool.checkSnapshot',
          'Saved tool output; not a live status.'
        )}
      </p>
      <ul className="max-h-64 overflow-auto scrollbar-sleek">
        {checks.map((check) => (
          <li
            key={JSON.stringify([check.url, check.name])}
            className="flex items-start justify-between gap-3 py-1"
          >
            <a
              href={check.url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 break-words text-primary underline underline-offset-2"
            >
              {check.name}
            </a>
            <span className={cn('shrink-0', CHECK_COLOR[getCheckConclusion(check)])}>
              {getCheckStatusLabel(check)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
