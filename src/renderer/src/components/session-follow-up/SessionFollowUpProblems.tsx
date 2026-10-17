import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { rosterPersonDetail, type TeamRosterPerson } from '../../../../shared/team-roster-search'
import type { FollowUpProblem } from './session-follow-up-draft'

function problemText(problem: FollowUpProblem): string {
  switch (problem.kind) {
    case 'person-choice':
      return translate('sessionFollowUp.chooseMatch', 'Choose who you meant by “{{name}}”:', {
        name: problem.match.query
      })
    case 'person-unknown':
      return translate('sessionFollowUp.unknownPerson', 'No active teammate matches “{{name}}”.', {
        name: problem.query
      })
    case 'no-people':
      return translate('sessionFollowUp.needPeople', 'Choose at least one person.')
    case 'too-many-people':
      return translate('sessionFollowUp.tooManyPeople', 'One next step goes to at most 20 people.')
    case 'no-task':
      return translate('sessionFollowUp.needTask', 'Choose the task this request belongs to.')
    case 'no-files':
      return translate(
        'sessionFollowUp.needFiles',
        'Name at least one output file, or add a final summary.'
      )
    case 'final-needs-files':
      return translate(
        'sessionFollowUp.finalNeedsFiles',
        'OmniConsole knows of no run manifest for this session. Name the final files to send.'
      )
    case 'file-outside':
      return translate('sessionFollowUp.fileOutside', '{{path}} is outside this workspace.', {
        path: problem.path
      })
    case 'too-many-files':
      return translate('sessionFollowUp.tooManyFiles', 'One request carries at most 32 files.')
  }
}

function problemKey(problem: FollowUpProblem): string {
  switch (problem.kind) {
    case 'person-choice':
      return `choice:${problem.match.query}`
    case 'person-unknown':
      return `unknown:${problem.query}`
    case 'file-outside':
      return `outside:${problem.path}`
    case 'no-people':
    case 'too-many-people':
    case 'no-task':
    case 'no-files':
    case 'final-needs-files':
    case 'too-many-files':
      return problem.kind
  }
}

/** What stops a save, with an explicit choice whenever a name fits more than one person. */
export function SessionFollowUpProblems({
  problems,
  onChoose
}: {
  problems: readonly FollowUpProblem[]
  onChoose: (person: TeamRosterPerson) => void
}): React.JSX.Element | null {
  const unique = [
    ...new Map(problems.map((problem) => [problemKey(problem), problem] as const)).entries()
  ]
  if (unique.length === 0) {
    return null
  }
  return (
    <ul role="alert" className="space-y-2 text-xs">
      {unique.map(([key, problem]) => (
        <li key={key} className="space-y-1">
          <p className="text-destructive">{problemText(problem)}</p>
          {problem.kind === 'person-choice' ? (
            <div className="flex flex-wrap gap-1">
              {problem.match.candidates.map((person) => (
                <Button
                  key={person.id}
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => onChoose(person)}
                >
                  {person.name}
                  <span className="text-muted-foreground">
                    {rosterPersonDetail(person) ?? person.id}
                  </span>
                </Button>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
