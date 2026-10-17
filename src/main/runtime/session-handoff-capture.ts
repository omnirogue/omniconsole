import { capturedHandoffFile as exactFile } from '../../shared/exact-handoff-file-read'
import { resolveSessionHandoffSource } from './session-handoff-source'
import { applySessionHandoffRouting } from './session-handoff-routing'
import { lstat, realpath } from 'node:fs/promises'
import * as pathApi from 'node:path'
import type { FollowUpHostIo } from '../../shared/session-follow-up-delivery-contract'
import {
  SESSION_FOLLOW_UP_MAX_FILE_BYTES,
  sessionFollowUpDisposition,
  type SessionFollowUpRule
} from '../../shared/session-follow-up-rule'
import { captureFollowUpFiles, resolveFollowUpFiles } from '../../shared/session-follow-up-delivery'
import {
  chosenDestination,
  destinationHoldsOtherBytes,
  materializeOne,
  packageNamesFreeInFolder,
  type HandoffDestinationIo
} from './session-handoff-destination'
import { createSshSessionHandoffIo } from './session-handoff-ssh-io'
import { captureHandoffAttachment } from '../backoffice/handoff-attachment-capture'
import { buildCompleteSessionTranscript } from '../transcripts/complete-session-transcript'
import { readCompleteSessionTranscript } from '../transcripts/complete-session-transcript-reader'
import { buildTranscriptFromMessages } from '../transcripts/session-transcript-deliverable'
import { transcriptErrorMessage } from '../../shared/conversation-transcript-deliverable'
import type { SessionFollowUpTranscriptSource } from '../../shared/session-follow-up-transcript'
import {
  assistantProse,
  authoredHandoffNote,
  buildSessionHandoffRequest,
  buildSessionHandoffSummary,
  conversationWrittenFiles,
  finalAssistantAnswer,
  firstPersonAsk,
  personWords
} from '../../shared/session-handoff-summary'
import { resolveWorkspaceOutputPath } from '../../shared/session-follow-up-deliverables'

export const sessionHandoffHostIo: FollowUpHostIo = {
  exists: async (path) => {
    try {
      await lstat(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw error
    }
  },
  size: async (path) => (await lstat(path)).size,
  readExact: async (path) => {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error('A handoff attachment cannot be a symbolic link.')
    }
    return captureHandoffAttachment(await realpath(path), undefined, true)
  }
}

export class HandoffDeliverablesMissing extends Error {}

type HandoffCaptureOwner = HandoffDestinationIo & {
  root: string
  io: FollowUpHostIo
  connectionId?: string
  materialize: (destination: string, bytes: Buffer) => Promise<void>
  /** Whether a destination (possibly outside the workspace) holds anything but exactly these bytes. */
  destinationHoldsOtherBytes: (destination: string, bytes: Buffer) => Promise<boolean>
  assertCurrent: () => void
  answerSource?: SessionFollowUpTranscriptSource
}

/**
 * The conversation's last answer, read from its own history so it does not depend on a fresh
 * agent hook or an open tab. Unreadable history is no answer; a secret in it refuses the handoff,
 * exactly as it refuses a transcript.
 */
type ConversationEnds = { asked: string | null; finalAnswer: string | null; written: string[] }
const NO_ENDS: ConversationEnds = { asked: null, finalAnswer: null, written: [] }
/** Inferred work files are a courtesy, not a declaration; a long session sends its latest few. */
const INFERRED_WORK_FILES_MAX = 12

async function conversationEnds(
  source: SessionFollowUpTranscriptSource,
  connectionId: string | undefined
): Promise<ConversationEnds> {
  if (source.hostId !== (connectionId ? `ssh:${connectionId}` : 'local')) {
    return NO_ENDS
  }
  if (source.runtimeEnvironmentId) {
    return NO_ENDS
  }
  const messages = await readCompleteSessionTranscript({
    ...source,
    expectedConnectionId: connectionId ?? null
  }).catch(() => null)
  const asked = messages ? firstPersonAsk(messages) : null
  const answer = messages ? finalAssistantAnswer(messages) : null
  const quoted = [asked, answer].filter((message) => message !== null)
  const written = messages ? conversationWrittenFiles(messages) : []
  if (!quoted.length) {
    return { ...NO_ENDS, written }
  }
  const gate = buildTranscriptFromMessages(
    { ...source, capturedAt: new Date().toISOString(), clipToolPayloads: false },
    quoted
  )
  if (gate.kind === 'refused') {
    throw new Error(
      `The request was not sent: the protected-data gate found ${gate.redactions} secret value(s) in what the conversation asked or answered.`
    )
  }
  return gate.kind === 'built'
    ? {
        asked: asked ? personWords(assistantProse(asked)) : null,
        finalAnswer: answer ? assistantProse(answer) : null,
        written
      }
    : { ...NO_ENDS, written }
}

/** The conversation's own files that still exist inside the workspace, newest last. */
async function inferredWorkFiles(
  written: readonly string[],
  workspacePath: string,
  io: FollowUpHostIo
): Promise<string[]> {
  const found: string[] = []
  for (const candidate of written.toReversed()) {
    const path = resolveWorkspaceOutputPath(workspacePath, candidate)
    // Why: the app's own run folders hold stage reports, which travel by manifest, not by guess.
    if (!path || /[\\/]\.omni[\\/]/.test(path) || found.includes(path)) {
      continue
    }
    const usable = await io
      .exists(path)
      .then(async (exists) => exists && (await io.size(path)) <= SESSION_FOLLOW_UP_MAX_FILE_BYTES)
      .catch(() => false)
    if (usable) {
      found.unshift(path)
    }
    if (found.length === INFERRED_WORK_FILES_MAX) {
      break
    }
  }
  return found
}

/**
 * Capture the existing artifact manifest, then materialize the same bytes at the chosen destination.
 * `answerSource` names the conversation whose final answer the summary carries; without it the
 * rule's own transcript source is used, and without either the summary is what the plan stated.
 */
export async function captureSessionHandoff(
  rule: SessionFollowUpRule,
  workspacePath: string,
  summary: string,
  answerSource?: SessionFollowUpTranscriptSource
): Promise<SessionFollowUpRule> {
  const root = await realpath(workspacePath)
  const io: FollowUpHostIo = {
    ...sessionHandoffHostIo,
    readExact: async (path) => {
      const inside = pathApi.relative(root, await realpath(path))
      if (
        !inside ||
        inside === '..' ||
        inside.startsWith(`..${pathApi.sep}`) ||
        pathApi.isAbsolute(inside)
      ) {
        throw new Error(
          'A selected handoff file or folder resolves outside the execution workspace.'
        )
      }
      return sessionHandoffHostIo.readExact(path)
    }
  }
  return captureOnOwner(rule, workspacePath, summary, {
    root,
    io,
    path: pathApi,
    realpath,
    materialize: materializeOne,
    destinationHoldsOtherBytes,
    assertCurrent: () => {},
    answerSource
  })
}

export async function captureSshSessionHandoff(
  rule: SessionFollowUpRule,
  workspacePath: string,
  summary: string,
  connectionId: string,
  assertOwner: () => void = () => {},
  answerSource?: SessionFollowUpTranscriptSource
): Promise<SessionFollowUpRule> {
  const owner = await createSshSessionHandoffIo(workspacePath, connectionId, assertOwner)
  return owner.owned(() =>
    captureOnOwner(rule, workspacePath, summary, { ...owner, connectionId, answerSource })
  )
}

async function captureOnOwner(
  rule: SessionFollowUpRule,
  workspacePath: string,
  summary: string,
  owner: HandoffCaptureOwner
): Promise<SessionFollowUpRule> {
  const { root, io } = owner
  const { basename, isAbsolute, join } = owner.path
  owner.assertCurrent()
  const files = await resolveFollowUpFiles(rule, workspacePath, io)
  owner.assertCurrent()
  if (files.missing.length) {
    throw new HandoffDeliverablesMissing(
      `Handoff deliverables missing: ${files.missing.join(', ')}`
    )
  }
  const source = resolveSessionHandoffSource(rule)
  const answerSource = owner.answerSource ?? rule.transcriptSource ?? source?.answerSource
  const ends = answerSource ? await conversationEnds(answerSource, owner.connectionId) : NO_ENDS
  owner.assertCurrent()
  // Why: "Work files" with no stage manifest and no named path used to send nothing at all.
  const workFiles =
    files.paths.length === 0 && rule.includeSummary && rule.deliverables.kind === 'files'
      ? await inferredWorkFiles(ends.written, workspacePath, io)
      : files.paths
  owner.assertCurrent()
  const summaryMarkdown = rule.includeSummary
    ? buildSessionHandoffSummary({ stated: summary, finalAnswer: ends.finalAnswer })
    : undefined
  const authoredNote = authoredHandoffNote(rule)
  const request = buildSessionHandoffRequest({
    relationship: sessionFollowUpDisposition(rule) === 'feedback' ? 'review' : 'handoff',
    authoredNote,
    asked: ends.asked,
    finalAnswer: ends.finalAnswer,
    fallbackTitle: rule.sessionLabel
  })
  let transcriptBytes: Buffer | undefined
  if (rule.transcriptSource) {
    const hostId = owner.connectionId ? `ssh:${owner.connectionId}` : 'local'
    if (rule.transcriptSource.hostId !== hostId || rule.transcriptSource.runtimeEnvironmentId) {
      throw new Error('This execution host does not own the selected session history.')
    }
    const transcript = await buildCompleteSessionTranscript({
      ...rule.transcriptSource,
      capturedAt: new Date().toISOString(),
      expectedConnectionId: owner.connectionId ?? null
    })
    owner.assertCurrent()
    if (transcript.kind === 'error') {
      throw new Error(transcriptErrorMessage(transcript.code, transcript.sizeBytes))
    }
    if (transcript.kind === 'refused') {
      throw new Error(
        `Session history was not sent: the protected-data gate found ${transcript.redactions} secret value(s).`
      )
    }
    transcriptBytes = transcript.deliverable.bytes
  }
  const summaryBytes = summaryMarkdown ? Buffer.from(summaryMarkdown) : undefined
  const names = await packageNamesFreeInFolder({
    topic: ends.asked ?? rule.sessionLabel,
    keptSummaryName: rule.summaryFile,
    folder: rule.destinationDirectory,
    bytes: { summary: summaryBytes, transcript: transcriptBytes },
    owner
  })
  owner.assertCurrent()
  const summaryName = names.summary
  const transcriptFile = transcriptBytes ? exactFile(names.transcript, transcriptBytes) : undefined
  const capture = await captureFollowUpFiles(
    workFiles,
    summaryBytes ? exactFile(summaryName, summaryBytes) : null,
    io,
    transcriptFile ?? null,
    rule.agentRecipients?.length ? 10 * 1024 * 1024 : undefined,
    rule.taskId === null && !rule.agentRecipients?.length
  )
  owner.assertCurrent()
  if (rule.destinationDirectory) {
    if (!isAbsolute(rule.destinationDirectory)) {
      throw new Error('Choose an absolute folder on the session execution host.')
    }
    for (const pin of capture.pins) {
      if (
        basename(pin.name) !== pin.name ||
        pin.name.includes('\\') ||
        pin.name === '.' ||
        pin.name === '..'
      ) {
        throw new Error('The artifact name is not a file name.')
      }
      const destination = await chosenDestination(
        root,
        workspacePath,
        join(rule.destinationDirectory, pin.name),
        owner
      )
      owner.assertCurrent()
      const bytes = capture.bytes.get(pin.name)!
      await owner.materialize(destination, Buffer.from(bytes.contentBase64, 'base64'))
      owner.assertCurrent()
      pin.sourcePath = destination
    }
  }
  return applySessionHandoffRouting(
    {
      ...rule,
      files: capture.pins,
      capturedAt: Date.now(),
      // Why: with nothing read from the conversation and nothing written, the plan's own text stands.
      ...(ends.asked || ends.finalAnswer || authoredNote ? { request } : {}),
      ...(summaryMarkdown ? { summaryFile: summaryName } : {}),
      ...(summaryMarkdown ? { summaryMarkdown } : {}),
      ...(transcriptFile ? { transcriptFile } : {})
    },
    workspacePath,
    source?.chainId,
    owner.connectionId
  )
}
