import { useState } from 'react'
import { Bot, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import {
  sendNotesToActiveAgentSession,
  activeAgentNotesSendFailureMessage
} from '@/lib/active-agent-note-send'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { sendInboxStructuredInstruction } from './inbox-structured-instruction'
import { translate as t } from '@/i18n/i18n'

export function InboxAgentAction({
  instruction,
  close
}: {
  instruction: string
  close: () => void
}) {
  const sessions = useSidebarSessions()
  const terminals = sessions.filter(
    (session) =>
      !session.unavailable &&
      session.tabId &&
      (session.kind === 'structured' ? !!session.structuredSessionId : !!session.paneKey)
  )
  const [selected, setSelected] = useState('')
  const [pending, setPending] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) {
          close()
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto scrollbar-sleek sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('inbox.actionTitle', 'Review instruction for your AI')}</DialogTitle>
          <DialogDescription>
            {t(
              'inbox.actionHelp',
              'Your AI performs this action with its own enrolled identity. This sends an instruction, not a delivery confirmation or approval to execute a handoff.'
            )}
          </DialogDescription>
        </DialogHeader>
        <Label htmlFor="inbox-agent">{t('inbox.yourAI', 'Your AI conversation')}</Label>
        <Select value={selected} onValueChange={setSelected} disabled={pending}>
          <SelectTrigger id="inbox-agent">
            <SelectValue placeholder={t('inbox.chooseAI', 'Choose an open AI conversation')} />
          </SelectTrigger>
          <SelectContent>
            {terminals.map((terminal) => (
              <SelectItem key={terminal.rowKey} value={terminal.rowKey}>
                {terminal.label} · {terminal.workspaceLabel}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {terminals.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t(
              'inbox.noAI',
              'Open an AI terminal to delegate this action, or copy the instruction into your AI conversation.'
            )}
          </p>
        )}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-xs scrollbar-sleek">
          {instruction}
        </pre>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={close}>
            {t('inbox.close', 'Close')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(instruction).then(
                () => setNotice(t('inbox.copied', 'Copied.')),
                (reason) => setError(String(reason))
              )
            }}
          >
            <Copy />
            {t('inbox.copyInstruction', 'Copy instruction')}
          </Button>
          <Button
            disabled={!selected || pending || attempted}
            onClick={async () => {
              setPending(true)
              setAttempted(true)
              setError('')
              try {
                const target = terminals.find((terminal) => terminal.rowKey === selected)
                if (!target) {
                  setAttempted(false)
                  throw new Error('The selected conversation is no longer available.')
                }
                if (target.kind === 'structured') {
                  await sendInboxStructuredInstruction(target, instruction)
                } else {
                  const pane = target?.paneKey ? parsePaneKey(target.paneKey) : null
                  if (!target.tabId || !pane) {
                    setAttempted(false)
                    throw new Error('The selected conversation is no longer available.')
                  }
                  const result = await sendNotesToActiveAgentSession({
                    worktreeId: target.worktreeId,
                    prompt: instruction,
                    noteTarget: { tabId: target.tabId, leafId: pane.leafId }
                  })
                  if (result.status !== 'sent') {
                    setAttempted(result.status === 'partial-submit-failed')
                    throw new Error(
                      activeAgentNotesSendFailureMessage(result.status, { explicitTarget: true })
                    )
                  }
                }
                setNotice(
                  t(
                    'inbox.instructed',
                    'Instruction sent to your AI. Refresh Inbox to check the actual delivery receipt.'
                  )
                )
              } catch (reason) {
                setError(
                  `${String(
                    reason
                  )} Check the AI conversation before preparing another instruction; delivery may be uncertain.`
                )
              } finally {
                setPending(false)
              }
            }}
          >
            <Bot />
            {t('inbox.sendToAI', 'Send to my AI')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
