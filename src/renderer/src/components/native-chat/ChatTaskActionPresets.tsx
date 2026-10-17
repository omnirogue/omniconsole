import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CreateTaskButton } from '@/components/tasks/CreateTaskButton'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { translate } from '@/i18n/i18n'

export function ChatTaskActionPresets({
  session,
  disabled,
  hasConversation,
  onSend
}: {
  session?: SidebarSession
  disabled: boolean
  hasConversation: boolean
  onSend: (text: string) => Promise<boolean> | boolean
}): React.JSX.Element | null {
  const sending = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  if (!session && (!hasConversation || disabled)) {
    return null
  }
  const send = async (text: string): Promise<void> => {
    if (sending.current) {
      return
    }
    sending.current = true
    setPending(true)
    setError('')
    try {
      if (!(await onSend(text))) {
        throw new Error(
          translate('chatActions.sendFailed', 'The action could not be sent. Try again.')
        )
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      sending.current = false
      setPending(false)
    }
  }
  return (
    <div className="mx-auto w-full max-w-4xl space-y-1.5 px-4 py-2" data-chat-task-actions>
      <div className="flex flex-wrap items-center gap-2">
        {session && <CreateTaskButton session={session} visibleLabel />}
        {hasConversation && !disabled && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                void send(
                  translate(
                    'chatActions.planStepsPrompt',
                    'Outline the steps for the current request, the people needed, and what the finished outcome should be. Include any due dates already agreed.'
                  )
                )
              }
            >
              {translate('chatActions.planSteps', 'Plan steps')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                void send(
                  translate(
                    'chatActions.summarizeProgressPrompt',
                    'Summarize the current progress: what is finished, what remains, who needs to act next, and the files or evidence available so far.'
                  )
                )
              }
            >
              {translate('chatActions.summarizeProgress', 'Summarize progress')}
            </Button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
