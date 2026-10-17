import { translate } from '@/i18n/i18n'
import { GoalsTodosGroupSection } from './GoalsTodosGroupSection'
import { useGoalsTodos } from './use-goals-todos'

/**
 * Goals & to-dos: every recent AI session's goal (its first prompt) and the to-do list the AI
 * itself published or wrote, grouped by whether it needs the person. Read-only by design —
 * it reads what the app and the agents already recorded and changes no agent setting.
 */
export default function GoalsTodosSidebar(): React.JSX.Element {
  const { groups, now } = useGoalsTodos()
  const total = groups['needs-you'].length + groups['in-progress'].length + groups.idle.length
  return (
    <section
      aria-label={translate('goalsTodos.title', 'Goals & to-dos')}
      className="flex min-h-0 flex-1 flex-col text-worktree-sidebar-foreground"
    >
      <p className="px-3 pb-2 pt-1 text-xs text-muted-foreground">
        {translate(
          'goalsTodos.intro',
          "Each AI session's goal and to-do list, read from what the AI already wrote. Nothing here changes your AI settings."
        )}
      </p>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {total === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {translate('goalsTodos.empty', 'No AI sessions from the last 7 days.')}
          </p>
        ) : null}
        <GoalsTodosGroupSection kind="needs-you" rows={groups['needs-you']} now={now} />
        <GoalsTodosGroupSection kind="in-progress" rows={groups['in-progress']} now={now} />
        <GoalsTodosGroupSection
          kind="idle"
          rows={groups.idle}
          now={now}
          hiddenCount={groups.idleHidden}
          defaultOpen={false}
        />
      </div>
    </section>
  )
}
