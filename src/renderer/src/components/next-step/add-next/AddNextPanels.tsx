import { UpNextSubject } from '@/components/next-action/UpNextSubject'
import { useAddNextDraft } from './use-add-next-draft'
import { SessionBulkActions } from '@/components/sidebar/session-folders/SessionBulkActions'
import { conversationViewKey } from '@/lib/conversation-view'
import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { findNextStepWorkspaceId } from '../next-step-placement'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { NextStepDraft, NextStepRecipient } from '../../../../../shared/next-step-draft'
import type { NextStepSubject } from '../next-step-subject'
import { useNextStepRecipients } from '../use-next-step-recipients'
import { LiveWorkPlanQuestions } from './LiveWorkPlanQuestions'
import { MenuChooser } from './MenuChooser'
import { MenuRecipients } from './MenuRecipients'
import { MenuPlan } from './MenuPlan'
import { useAddNextSend } from './use-add-next-send'
import { NewPromptPanel } from '@/components/prompt-queue/NewPromptPanel'
import { conversationSourceForSession } from '@/lib/conversation-source-for-session'
import { draftWithLevels, pickLevelRecipient, type MenuLevel } from './menu-levels'

type PanelProps = {
  subject: NextStepSubject
  /** Ignored compatibility input for callers migrated by other seats. */
  dispatch?: boolean
  /** Once the person clicked inside, a hover over a computer only highlights; the click stays the choice. */
  isPinned?: () => boolean
  initialKind?: 'agent' | 'person'
  onSent: () => void
}

export function AddNextPanels({ subject, initialKind, onSent }: PanelProps) {
  const editor = useAddNextDraft(subject, false, initialKind)
  const [draft, setDraft] = editor.draft
  const [levels, setLevels] = editor.levels
  const [current, setCurrent] = editor.current
  const [mode, setMode] = editor.mode
  const [kind, setKind] = editor.kind
  const plan = subject.kind === 'session'
  const destinationId = useAppStore((state) =>
    subject.kind === 'session' && draft.placement
      ? findNextStepWorkspaceId(state, subject.session.worktreeId, draft.placement)
      : null
  )
  const destination = destinationId
    ? (useAppStore.getState().getKnownWorktreeById(destinationId) ?? null)
    : null
  const recipientSubject =
    destination && subject.kind === 'session'
      ? {
          ...subject,
          session: { ...subject.session, worktreeId: destination.id, hostId: draft.placement }
        }
      : subject
  const { error, action, pending, done, send, clear } = useAddNextSend({
    subject,
    fleet: null,
    linkedTask: null,
    onSent: () => {
      editor.clear()
      onSent()
    }
  })
  const local = useNextStepRecipients(recipientSubject)
  const data = local
  const [preview, setPreview] = useState<NextStepRecipient | null>(null)
  const [bulk, setBulk] = useState(false)
  const [whereDispatch, setWhereDispatch] = useState(false)
  const [newPrompt, setNewPrompt] = useState(false)
  const conversationSource =
    subject.kind === 'session' ? conversationSourceForSession(subject.session) : null
  const committed = levels[current]
  const active: MenuLevel = committed?.recipients.length
    ? committed
    : preview
      ? { mode, recipients: [preview] }
      : (committed ?? { mode, recipients: [] })
  const fullDraft = draftWithLevels(
    destinationId ? { ...draft, destinationWorktreeId: destinationId } : draft,
    levels
  )
  const usableAgents = data.agents.phase === 'ready' ? data.agents.value : []
  const sessionAgent = subject.kind === 'session' ? subject.session.agent.toLowerCase() : ''
  const continueAgent =
    usableAgents.find(
      (agent) => agent.id === sessionAgent || agent.label.toLowerCase() === sessionAgent
    ) ??
    usableAgents[0] ??
    null
  const continueWork = (end: NextStepDraft['end']): NextStepDraft => ({
    ...fullDraft,
    end,
    mode: 'handoff',
    recipients: continueAgent
      ? [
          {
            kind: 'agent',
            key: crypto.randomUUID(),
            agent: continueAgent.id,
            presetId: null,
            rounds: 1,
            instructions: translate(
              'nextStep.continueCurrentWork',
              'Continue the current work using the session context. Complete its outstanding request.'
            )
          }
        ]
      : []
  })
  const worktreeId =
    destination?.id ?? (subject.kind === 'session' ? subject.session.worktreeId : null)
  const update = (level: MenuLevel): void => {
    clear()
    setLevels((previous) => {
      if (!level.recipients.length) {
        return previous.filter((_, index) => index !== current)
      }
      const next = { ...level, id: previous[current]?.id ?? crypto.randomUUID() }
      return [...previous.slice(0, current), next, ...previous.slice(current + 1)].slice(0, 5)
    })
    setPreview(null)
  }
  const chooseKind = (next: 'agent' | 'person' | null): void => {
    setKind(next)
    setPreview(null)
  }
  const pick = (recipient: NextStepRecipient): void => {
    update(
      pickLevelRecipient(
        { ...levels[current], recipients: levels[current]?.recipients ?? [], mode },
        recipient
      )
    )
  }
  if (newPrompt && conversationSource) {
    return <NewPromptPanel source={conversationSource} onClose={onSent} />
  }
  if (bulk && subject.kind === 'session') {
    return (
      <div>
        <button type="button" className="px-3 pt-2 text-xs" onClick={() => setBulk(false)}>
          {translate('sessions.backToNext', 'Back to next step')}
        </button>
        <SessionBulkActions initialKey={conversationViewKey(subject.session)} />
      </div>
    )
  }
  const chooser = (
    <MenuChooser
      subject={subject}
      workPlan={
        initialKind !== 'agent' && subject.kind === 'session' ? (
          <LiveWorkPlanQuestions
            subject={subject}
            data={data}
            initialPerson={initialKind === 'person'}
            onSent={onSent}
            onWhere={(next, action, instruction) => {
              if (next === 'fleet') {
                setWhereDispatch(true)
                return
              }
              setWhereDispatch(false)
              chooseKind(next)
              if (action) {
                setDraft((previous) => ({ ...previous, instructions: instruction ?? '' }))
              }
            }}
          />
        ) : undefined
      }
      dispatching={false}
      levelCount={levels.length}
      endsOnSuccess={draft.end === 'done'}
      conversationSource={conversationSource}
      onNewPrompt={() => setNewPrompt(true)}
      onKind={chooseKind}
      onPlanEnd={() => setDraft((previous) => ({ ...previous, end: 'done' }))}
      onSent={onSent}
      onBulk={() => setBulk(true)}
    />
  )
  const recipients = kind ? (
    <MenuRecipients
      kind={kind}
      level={{ ...active, mode }}
      data={data}
      onMode={(next) => {
        setMode(next)
        setPreview(null)
        if (levels[current]) {
          update({
            mode: next,
            recipients:
              next === 'handoff'
                ? // Why: the surviving recipient is no longer a reviewer; keeping presetId 'review'
                  levels[current].recipients
                    .slice(0, 1)
                    .map((entry) =>
                      entry.kind === 'agent' && entry.presetId === 'review'
                        ? { ...entry, presetId: 'improve' as const }
                        : entry
                    )
                : levels[current].recipients.map((entry) =>
                    entry.kind === 'agent' ? { ...entry, presetId: 'review', rounds: 1 } : entry
                  )
          })
        }
      }}
      onPreview={setPreview}
      onPick={pick}
    />
  ) : null
  return (
    <div
      className="flex flex-wrap items-start"
      data-add-next-panels
      onPointerLeave={() => setPreview(null)}
    >
      <div className="w-52 shrink-0 space-y-2 p-2">{chooser}</div>
      {whereDispatch ? <UpNextSubject subject={subject} /> : null}
      {current === 0 ? recipients : null}
      {preview || levels.length || draft.placement ? (
        <MenuPlan
          levels={levels}
          current={current}
          active={active}
          chooser={current > 0 ? recipients : null}
          draft={fullDraft}
          worktreeSelector={worktreeId ? toRuntimeWorktreeSelector(worktreeId) : null}
          destinationLabel={
            draft.placement ? (destination?.displayName ?? destination?.path ?? null) : null
          }
          pending={pending}
          sent={done}
          error={error}
          errorAction={action}
          dispatch={false}
          plan={plan}
          onEdit={(index) => {
            setCurrent(index)
            setPreview(null)
            setMode(levels[index]!.mode)
            setKind(levels[index]!.recipients[0]?.kind ?? 'agent')
          }}
          onLevel={update}
          onDraft={setDraft}
          onThen={(next) => {
            const count = levels.length
            if (count >= 5) {
              return
            }
            setPreview(null)
            setCurrent(count)
            setMode('handoff')
            chooseKind(next)
          }}
          onSend={() =>
            void (levels.length === 0
              ? send(continueWork(draft.end), null, false)
              : send(fullDraft, null, false))
          }
        />
      ) : null}
    </div>
  )
}
