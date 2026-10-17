import { useState } from 'react'
import { BarChart3, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

export type TeamSurveyResultQuestion = { id: string; title: string } & (
  | { type: 'text' }
  | {
      type: 'single-choice' | 'multiple-choice' | 'rating'
      options: readonly { value: string; label: string }[]
    }
)

export type TeamSurveyResultResponse = {
  surveyId: string
  personId: string
  status: 'draft' | 'submitted'
  /** Epoch milliseconds; the newest response per person wins. */
  updatedAt: number
  answers: Readonly<Record<string, string | number | readonly string[] | null | undefined>>
}

export type TeamSurveyResultsPanelProps = {
  survey: { id: string; title: string; questions: readonly TeamSurveyResultQuestion[] }
  participants: readonly { id: string; name: string }[]
  /** Supply new snapshots from the caller's live subscription. */
  responses: readonly TeamSurveyResultResponse[]
  connectionStatus?: 'live' | 'connecting' | 'offline' | 'snapshot'
  isLoading?: boolean
  error?: string | null
  onRetry?: () => void
  className?: string
}

function answerValues(
  question: TeamSurveyResultQuestion,
  answer: TeamSurveyResultResponse['answers'][string]
): string[] {
  if (answer === null || answer === undefined) {
    return []
  }
  if (question.type === 'text') {
    return typeof answer === 'string' && answer.trim() ? [answer.trim()] : []
  }
  const values =
    typeof answer === 'number' || typeof answer === 'string' ? [String(answer)] : answer
  if (question.type !== 'multiple-choice' && values.length !== 1) {
    return []
  }
  const allowed = new Set(question.options.map((option) => option.value))
  return [...new Set(values)].filter((value) => allowed.has(value))
}

function QuestionHistogram({
  question,
  responses
}: {
  question: TeamSurveyResultQuestion
  responses: readonly TeamSurveyResultResponse[]
}) {
  const answers = responses.map((response) => answerValues(question, response.answers[question.id]))
  const answered = answers.filter((answer) => answer.length > 0).length
  const counts = new Map<string, number>()
  for (const answer of answers) {
    for (const value of answer) {
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
  }

  return (
    <Card className="gap-3 py-4 shadow-none">
      <CardHeader className="gap-1 px-4">
        <h3 className="text-sm font-medium break-words">{question.title}</h3>
        <p className="text-xs text-muted-foreground">
          {answered} answered · {responses.length - answered} unanswered
        </p>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {question.type === 'text' ? (
          <p className="text-sm text-muted-foreground">See the Per-person answers tab.</p>
        ) : (
          <>
            {question.options.length === 0 && (
              <p className="text-sm text-muted-foreground">No answer options configured.</p>
            )}
            <ul className="space-y-3" aria-label={`Response distribution: ${question.title}`}>
              {question.options.map((option) => {
                const count = counts.get(option.value) ?? 0
                const percent = answered ? (count / answered) * 100 : 0
                return (
                  <li key={option.value} className="space-y-1">
                    <div className="flex items-start justify-between gap-3 text-sm">
                      <span className="min-w-0 break-words">{option.label}</span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {count} ({Math.round(percent)}%)
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <div
                        className="h-full rounded-full bg-chart-1"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
            {question.type === 'multiple-choice' && (
              <p className="text-xs text-muted-foreground">
                Multiple selections allowed; percentages may total more than 100%.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function TeamSurveyResultsPanel({
  survey,
  participants,
  responses,
  connectionStatus = 'snapshot',
  isLoading = false,
  error,
  onRetry,
  className
}: TeamSurveyResultsPanelProps) {
  const [search, setSearch] = useState('')
  const people = [...new Map(participants.map((person) => [person.id, person])).values()]
  const participantIds = new Set(people.map((person) => person.id))
  const latest = new Map<string, TeamSurveyResultResponse>()
  for (const response of responses) {
    if (response.surveyId !== survey.id || !participantIds.has(response.personId)) {
      continue
    }
    if (!Number.isFinite(response.updatedAt)) {
      continue
    }
    const previous = latest.get(response.personId)
    if (!previous || response.updatedAt >= previous.updatedAt) {
      latest.set(response.personId, response)
    }
  }
  const submitted = [...latest.values()].filter((response) => response.status === 'submitted')
  const completed = submitted.length
  const inProgress = latest.size - completed
  const completion = people.length ? (completed / people.length) * 100 : 0
  const query = search.trim().toLocaleLowerCase()
  const visiblePeople = people.filter((person) => person.name.toLocaleLowerCase().includes(query))
  const connectionLabel = {
    live: 'Live updates',
    connecting: 'Connecting…',
    offline: 'Offline · showing saved results',
    snapshot: 'Snapshot'
  }[connectionStatus]

  return (
    <section
      aria-label={`${survey.title} results`}
      aria-busy={isLoading}
      className={cn(
        'scrollbar-sleek min-h-0 min-w-0 space-y-4 overflow-y-auto p-4 text-foreground',
        className
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <BarChart3 aria-hidden="true" className="size-4 shrink-0" />
            <span className="break-words">{survey.title}</span>
          </h2>
          <p className="text-xs text-muted-foreground">Survey results · submitted answers only</p>
        </div>
        <Badge variant="outline" role="status">
          {error ? 'Updates unavailable' : connectionLabel}
        </Badge>
      </header>

      {error && (
        <div role="alert" className="space-y-2 rounded-md border border-destructive p-3 text-sm">
          <p className="break-words text-destructive">{error}</p>
          <p className="text-muted-foreground">Results may be out of date.</p>
          {onRetry && (
            <Button variant="outline" size="sm" disabled={isLoading} onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      )}
      {isLoading && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
          Loading survey results…
        </p>
      )}

      {people.length === 0 ? (
        !isLoading &&
        !error && (
          <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">
            No participants yet. Invite people to this survey to track completion.
          </p>
        )
      ) : (
        <>
          <Card className="gap-3 py-4 shadow-none">
            <CardContent className="space-y-3 px-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">Completion rate</h3>
                <p className="text-sm tabular-nums" aria-live="polite" aria-atomic="true">
                  {Math.round(completion)}% · {completed} of {people.length} submitted
                </p>
              </div>
              <Progress
                value={completion}
                aria-label="Survey completion"
                className="bg-muted [&_[data-slot=progress-indicator]]:bg-chart-1 [&_[data-slot=progress-indicator]]:motion-reduce:transition-none"
              />
              <p className="text-xs text-muted-foreground">
                {inProgress} in progress · {people.length - latest.size} not started
              </p>
            </CardContent>
          </Card>
          {completed === 0 && (
            <p className="text-sm text-muted-foreground">No submitted responses yet.</p>
          )}
          <Tabs defaultValue="summary">
            <TabsList aria-label="Survey result views" className="h-auto max-w-full flex-wrap">
              <TabsTrigger value="summary">Response histograms</TabsTrigger>
              <TabsTrigger value="people">Per-person answers</TabsTrigger>
            </TabsList>
            <TabsContent value="summary" className="space-y-3 pt-2">
              <p className="text-xs text-muted-foreground">
                Percentages are based on people who answered each question.
              </p>
              {survey.questions.length === 0 && (
                <p className="text-sm text-muted-foreground">This survey has no questions.</p>
              )}
              {survey.questions.map((question) => (
                <QuestionHistogram key={question.id} question={question} responses={submitted} />
              ))}
            </TabsContent>
            <TabsContent value="people" className="space-y-3 pt-2">
              <Input
                type="search"
                aria-label="Find a participant"
                placeholder="Find a participant…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {visiblePeople.length === 0 ? (
                <p role="status" className="text-sm text-muted-foreground">
                  No participants match your search.
                </p>
              ) : (
                <div className="scrollbar-sleek overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">Individual survey responses</caption>
                    <thead className="border-b border-border bg-muted text-muted-foreground">
                      <tr>
                        <th scope="col" className="p-3 font-medium">
                          Person
                        </th>
                        <th scope="col" className="p-3 font-medium">
                          Status
                        </th>
                        {survey.questions.map((question) => (
                          <th
                            key={question.id}
                            scope="col"
                            className="min-w-40 p-3 font-medium break-words"
                          >
                            {question.title}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {visiblePeople.map((person) => {
                        const response = latest.get(person.id)
                        const isSubmitted = response?.status === 'submitted'
                        const status = isSubmitted
                          ? 'Submitted'
                          : response
                            ? 'In progress'
                            : 'Not started'
                        return (
                          <tr key={person.id} className="align-top">
                            <th scope="row" className="p-3 font-medium break-words">
                              {person.name}
                            </th>
                            <td className="p-3">
                              <Badge variant="secondary">{status}</Badge>
                            </td>
                            {survey.questions.map((question) => {
                              const values = isSubmitted
                                ? answerValues(question, response.answers[question.id])
                                : []
                              const labels = values.map((value) =>
                                question.type === 'text'
                                  ? value
                                  : (question.options.find((option) => option.value === value)
                                      ?.label ?? value)
                              )
                              return (
                                <td
                                  key={question.id}
                                  className="max-w-80 p-3 whitespace-pre-wrap break-words"
                                >
                                  {labels.length ? (
                                    labels.join(', ')
                                  ) : (
                                    <span className="text-muted-foreground">
                                      {isSubmitted ? 'No answer' : 'Not submitted'}
                                    </span>
                                  )}
                                </td>
                              )
                            })}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </section>
  )
}
