import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useHandoffPeople } from '@/components/next-step/use-handoff-people'
import { RoutineMemberAvatars } from '@/components/sidebar/routines/RoutineMemberAvatars'
import { resolveRoutineAccess } from '@/components/sidebar/routines/routine-access'
import { teamRoutinesApi } from '@/components/sidebar/routines/team-routines-client'
import { translate } from '@/i18n/i18n'
import type { TeamRoutine } from '../../../../shared/console-team-routines-contract'
import type {
  BoardConversationTurn,
  TeamRoutineRun
} from '../../../../shared/console-routine-conversation-contract'
import {
  companiesData,
  conversationError,
  orderedRuns,
  runKey,
  runStatus
} from './routine-conversation-data'
import { RoutineRunTranscript } from './RoutineRunTranscript'

export function RoutineConversationPanel({
  routine,
  name,
  schedule,
  open,
  onOpenChange
}: {
  routine: TeamRoutine
  name: string
  schedule: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { people, employeeId } = useHandoffPeople()
  const access = resolveRoutineAccess(
    routine,
    people.phase === 'ready' ? people.value : [],
    employeeId
  )
  const members = [...(access.owner ? [access.owner] : []), ...(access.collaborators ?? [])]
  const focus = useRef<HTMLHeadingElement>(null)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full sm:max-w-3xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          focus.current?.focus()
        }}
      >
        <SheetHeader>
          <SheetTitle ref={focus} tabIndex={-1}>
            {name}
          </SheetTitle>
          <SheetDescription>
            {translate(
              'routineConversation.description',
              'Conversations with the agent for each routine run.'
            )}
          </SheetDescription>
          {schedule ? <p className="text-xs text-muted-foreground">{schedule}</p> : null}
          <RoutineMemberAvatars collaborators={members} />
          {routine.last_run_at ? (
            <p className="text-xs text-muted-foreground">
              {translate('routineConversation.lastRun', 'Last run: {{time}}', {
                time: new Date(routine.last_run_at).toLocaleString()
              })}
            </p>
          ) : null}
          {routine.next_due ? (
            <p className="text-xs text-muted-foreground">
              {translate('routineConversation.nextRun', 'Next run: {{time}}', {
                time: new Date(routine.next_due).toLocaleString()
              })}
            </p>
          ) : null}
        </SheetHeader>
        {open && routine.id ? <RoutineRuns key={routine.id} routineId={routine.id} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function RoutineRuns({ routineId }: { routineId: string }) {
  const [runs, setRuns] = useState<TeamRoutineRun[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const posted = useRef(new Map<string, BoardConversationTurn[]>())
  const live = useRef(true)
  const refreshRuns = useCallback(async () => {
    try {
      const rows = orderedRuns(companiesData(await teamRoutinesApi().runs({ id: routineId })))
      if (!live.current) {
        return
      }
      setRuns(rows)
      setError('')
      setSelected((current) =>
        rows.some((run, index) => runKey(run, index) === current)
          ? current
          : rows.length
            ? runKey(rows[0], 0)
            : null
      )
    } catch (reason) {
      if (live.current) {
        setError(conversationError(reason))
      }
      throw reason
    }
  }, [routineId])
  useEffect(() => {
    live.current = true
    void refreshRuns().catch(() => undefined)
    return () => {
      live.current = false
    }
  }, [refreshRuns])
  const run = runs?.find((row, index) => runKey(row, index) === selected)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 px-4">
        <Label htmlFor="routine-run-picker">{translate('routineConversation.run', 'Run')}</Label>
        <Select value={selected ?? ''} onValueChange={setSelected}>
          <SelectTrigger id="routine-run-picker">
            <SelectValue placeholder={translate('routineConversation.chooseRun', 'Choose a run')} />
          </SelectTrigger>
          <SelectContent>
            {runs?.map((row, index) => (
              <SelectItem key={runKey(row, index)} value={runKey(row, index)}>
                {row.started_at || row.created_at
                  ? new Date(row.started_at ?? row.created_at!).toLocaleString()
                  : translate('routineConversation.unknownTime', 'Unknown time')}{' '}
                · {runStatus(row)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={() => void refreshRuns().catch(() => undefined)}>
          {translate('routineConversation.refreshRuns', 'Refresh runs')}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {!runs && !error ? (
          <p role="status">{translate('routineConversation.loadingRuns', 'Loading runs…')}</p>
        ) : null}
        {runs?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {translate(
              'routineConversation.noRuns',
              'No runs yet — the AI starts a conversation each time this routine runs'
            )}
          </p>
        ) : null}
        {run && !run.board_task_id ? (
          <p className="text-sm text-muted-foreground">
            {translate(
              'routineConversation.noCard',
              'This run has no board card. Its conversation is unavailable.'
            )}
          </p>
        ) : null}
      </div>
      {run?.board_task_id ? (
        <RoutineRunTranscript
          key={selected}
          taskId={run.board_task_id}
          active={run.finished_at == null}
          refreshRuns={refreshRuns}
          posted={posted.current}
        />
      ) : null}
    </div>
  )
}
