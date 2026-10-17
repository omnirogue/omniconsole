import { companiesApi, companiesData } from '@/components/companies/companies-client'
import {
  clearPendingHandoff,
  readPendingHandoff,
  retainPendingHandoff,
  updatePendingSessionHandoff
} from '@/components/handoffs/handoff-request-memory'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { createTerminalWaitDependencies } from '@/lib/next-session-launch'
import { workspaceRuntimeTarget } from '@/lib/session-chain-support'
import { deliverSessionFollowUp } from '@/lib/session-follow-up-delivery'
import { createFollowUpHostIo, createFollowUpHubIo } from '@/lib/session-follow-up-io'
import { summaryFile } from '@/lib/session-follow-up-completion'
import { readSessionWorkOutput } from '@/lib/session-work-output'
import { useAppStore } from '@/store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { NextStepDraft } from '../../../../shared/next-step-draft'
import type { SessionFollowUpRule } from '../../../../shared/session-follow-up-rule'
import { sessionFollowUpTranscriptSource } from '../../../../shared/session-follow-up-transcript'
import { transcriptSourceForSubject } from './use-transcript-preview'
import { captureImmediateSessionHandoff } from './capture-immediate-session-handoff'

/** The host names the generated summary after the operation. */
function summaryPinName(operationId: string): string {
  return `session-${operationId}.md`
}

/** Current snapshot through the same handoff transport; it never mutates the source's completion or queued outcomes. */
export async function handoffSessionNow(
  session: SidebarSession,
  draft: NextStepDraft,
  workspacePath: string
): Promise<void> {
  const outcome = draft.outcomes?.[0]
  const finish = outcome?.finish
  if (
    !outcome ||
    draft.outcomes?.length !== 1 ||
    finish?.kind !== 'person' ||
    !finish.personId ||
    outcome.steps.length
  ) {
    throw new Error('Choose one teammate. Steps before the handoff run with When done.')
  }
  if (!session.paneKey) {
    throw new Error('Open the source session before handing it off.')
  }
  const scope = selectConsoleAccountScope(useAppStore.getState())
  const person = companiesData(await companiesApi().me()).user?.id
  if (!person) {
    throw new Error('Sign in before handing off this session.')
  }
  const target = `session-now:${person}:${session.hostId}:${session.rowKey}`
  const checkIdentity = async (): Promise<void> => {
    if (
      selectConsoleAccountScope(useAppStore.getState()) !== scope ||
      companiesData(await companiesApi().me()).user?.id !== person
    ) {
      throw new Error('The signed-in person changed. Restore the original account before retrying.')
    }
  }
  let pending = readPendingHandoff(scope, target)
  if (pending && pending.kind !== 'session') {
    throw new Error('Another handoff request is pending.')
  }
  const requestedNote =
    outcome.instructions.trim() ||
    draft.note.trim() ||
    `Continue from the current work in ${session.label}.`
  const includeTranscript = draft.handoff.includeTranscript === true
  const retainedBody = pending?.kind === 'session' ? pending.body : null
  if (
    retainedBody &&
    (retainedBody.rule.recipients[0]?.employeeId !== finish.personId ||
      retainedBody.rule.note !== requestedNote ||
      retainedBody.rule.action !== finish.action ||
      retainedBody.rule.communicationType !== draft.handoff.communicationType ||
      retainedBody.rule.includeSummary !== draft.handoff.includeSummary ||
      retainedBody.rule.disposition !==
        (finish.disposition === 'ownership' ? 'ownership-transfer' : 'feedback') ||
      retainedBody.rule.destinationDirectory !==
        (draft.handoff.destinationDirectory ?? workspacePath) ||
      (Boolean(retainedBody.rule.transcriptSource) ||
        (retainedBody.rule.files ?? []).some(
          (pin) => pin.sourcePath === null && pin.name !== summaryPinName(retainedBody.operationId)
        )) !== includeTranscript)
  ) {
    throw new Error(
      'A previous handoff is awaiting confirmation. Restore its original teammate, access, instructions and folder before retrying.'
    )
  }
  if (!pending) {
    const transcriptSource = includeTranscript
      ? sessionFollowUpTranscriptSource.parse(
          transcriptSourceForSubject({ kind: 'session', session })
        )
      : undefined
    const signal = new AbortController().signal
    const source = createTerminalWaitDependencies(
      workspaceRuntimeTarget(session.worktreeId),
      { sourcePaneKey: session.paneKey, worktreeId: session.worktreeId },
      signal
    )
    const context = await readSessionWorkOutput(
      session,
      session.paneKey,
      async () => (await source.resolveSource()).handle,
      signal
    )
    if (!context.trim()) {
      throw new Error(
        'The current session context could not be read. Try again once it is available.'
      )
    }
    const operationId = crypto.randomUUID().replace(/-/g, '')
    const rule: SessionFollowUpRule = {
      revision: 1,
      taskId: null,
      taskTitle: session.label,
      sessionLabel: session.label,
      recipients: [
        {
          employeeId: finish.personId,
          name: finish.personName || finish.personId,
          operationId,
          delivery: 'pending'
        }
      ],
      action: finish.action,
      ...(draft.handoff.communicationType
        ? { communicationType: draft.handoff.communicationType }
        : {}),
      disposition: finish.disposition === 'ownership' ? 'ownership-transfer' : 'feedback',
      deliverables: draft.handoff.deliverables ?? { kind: 'files', paths: [] },
      destinationDirectory: draft.handoff.destinationDirectory ?? workspacePath,
      // Why: the Package checkbox is one promise for both timings; Send now keeps it too.
      includeSummary: draft.handoff.includeSummary,
      ...(transcriptSource ? { transcriptSource } : {}),
      note: requestedNote,
      savedAt: Date.now()
    }
    await checkIdentity()
    const captured = await captureImmediateSessionHandoff(
      session,
      rule,
      `# ${session.label}\n\nCurrent handoff snapshot; the source work may still be running.\n\nRequested next action: ${rule.note}\n\n${context.slice(-18_000)}`.slice(
        0,
        20_000
      )
    )
    await checkIdentity()
    const { transcriptFile, ...retained } = captured
    if (includeTranscript) {
      const pin = retained.files?.find((file) => file.generatedKind === 'transcript')
      if (
        !transcriptFile ||
        !pin?.sourcePath ||
        pin.name !== transcriptFile.name ||
        pin.sha256 !== transcriptFile.sha256 ||
        pin.size !== transcriptFile.size
      ) {
        throw new Error(
          'The execution host did not retain the complete transcript. Nothing was sent.'
        )
      }
      // Keep the host's physical snapshot; multi-megabyte transcript bytes do not belong in localStorage.
      retained.files = retained.files?.map(({ generatedKind: _generated, ...file }) => file)
    }
    pending = retainPendingHandoff(scope, target, {
      kind: 'session',
      body: { operationId, rule: retained }
    })
  }
  if (pending.kind !== 'session') {
    throw new Error('The pending session handoff could not be read.')
  }
  let rule = pending.body.rule
  const operationId = pending.body.operationId
  if (rule.recipients.every((recipient) => recipient.delivery === 'sent' && recipient.threadId)) {
    await checkIdentity()
    clearPendingHandoff(scope, target, operationId)
    return
  }
  const io = createFollowUpHostIo(session)
  const transport = createFollowUpHubIo()
  const result = await deliverSessionFollowUp({
    current: () => (selectConsoleAccountScope(useAppStore.getState()) === scope ? rule : null),
    save: async (next) => {
      updatePendingSessionHandoff(scope, target, {
        kind: 'session',
        body: { operationId, rule: next }
      })
      rule = next
    },
    hub: {
      ...transport,
      sendCardless: async (input) => {
        await checkIdentity()
        return transport.sendCardless(input)
      },
      uploadThreadFile: async (input) => {
        await checkIdentity()
        return transport.uploadThreadFile(input)
      }
    },
    bytes: async (pin) => {
      if (pin.sourcePath) {
        return io.readExact(pin.sourcePath)
      }
      if (pin.name === summaryPinName(operationId)) {
        return summaryFile(pin.name, rule.summaryMarkdown ?? '')
      }
      throw new Error(
        'The original transcript snapshot is unavailable. Its pending delivery was preserved.'
      )
    },
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  })
  if (result !== 'delivered') {
    throw new Error('Delivery is not yet confirmed. Retry to recover the original receipt.')
  }
  clearPendingHandoff(scope, target, operationId)
}
