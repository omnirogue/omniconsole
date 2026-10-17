/**
 * `omni session organize|tag|hide|unhide|snooze` — an agent organizes the Conversations sidebar
 * like the person, in bulk. Each command is an organize plan sent to `sessionOrganization.organize`;
 * the single-purpose ones are one-entry plans per pane, applied unless --dry-run.
 */

import { readFileSync } from 'node:fs'
import {
  parseSnoozeUntil,
  SESSION_ORGANIZE_RPC,
  SessionOrganizePlanSchema,
  type SessionOrganizeEntry,
  type SessionOrganizePlan,
  type SessionOrganizeResult
} from '../../shared/session-organize'
import type { SessionFocusEstimate } from '../../shared/session-organize-focus'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { sessionProvenance } from './session-provenance-flags'

type Flags = HandlerContext['flags']

const MAX_PLAN_BYTES = 5 * 1024 * 1024

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function panesOf(flags: Flags): string[] {
  const panes = list(getOptionalStringFlag(flags, 'pane'))
  if (panes.length > 0) {
    return [...new Set(panes)]
  }
  const own = process.env.ORCA_PANE_KEY?.trim()
  if (!own) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Name the sessions with --pane <paneKey>[,<paneKey>...] (from omni session list); this is not running inside an OmniConsole terminal pane.'
    )
  }
  return [own]
}

function snoozeOf(value: unknown): number | null {
  if (value === null || typeof value === 'number') {
    return value
  }
  if (typeof value !== 'string') {
    throw new RuntimeClientError('invalid_argument', 'A snooze is a wake time string or null.')
  }
  try {
    return parseSnoozeUntil(value)
  } catch (error) {
    throw new RuntimeClientError('invalid_argument', (error as Error).message)
  }
}

/** Parses and checks a plan, turning each snooze string ("+2h", "tomorrow 9:00") into a time. */
export function parseOrganizePlan(text: string): SessionOrganizePlan {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      `The plan is not JSON: ${(error as Error).message}`
    )
  }
  const changes = (raw as { changes?: unknown })?.changes
  if (Array.isArray(changes)) {
    for (const entry of changes) {
      if (entry && typeof entry === 'object' && 'snooze' in entry) {
        const record = entry as { snooze: unknown }
        record.snooze = snoozeOf(record.snooze)
      }
    }
  }
  const parsed = SessionOrganizePlanSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new RuntimeClientError(
      'invalid_argument',
      `The plan is not valid at ${issue?.path.join('.') || 'the top'}: ${issue?.message ?? 'unknown problem'}.`
    )
  }
  return parsed.data
}

function readPlanText(source: string): string {
  if (source === '-') {
    return readFileSync(0, 'utf-8')
  }
  const text = readFileSync(source, 'utf-8')
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) {
    throw new RuntimeClientError('invalid_argument', 'The plan is larger than 5 MB.')
  }
  return text
}

function formatFocus(label: string, focus: SessionFocusEstimate): string {
  const parts = [
    focus.needsYou > 0 ? `Needs you · ${focus.needsYou}` : null,
    ...focus.folders,
    focus.everythingElse.sessions > 0
      ? `Everything else · ${focus.everythingElse.sessions} sessions in ${focus.everythingElse.folders} folders`
      : null
  ].filter(Boolean)
  const folded =
    focus.folded.length > 0
      ? ` (${focus.folded.length} busy folders fold into Everything else)`
      : ''
  return `${label}: ${focus.lines} of ${focus.budget} lines — ${parts.join(' | ') || 'empty'}${folded}`
}

export function formatOrganizeResult(result: SessionOrganizeResult): string {
  const lines = [result.dryRun ? 'Dry run — nothing changed.' : 'Applied.']
  for (const folder of result.folders) {
    const color = folder.color !== undefined ? ` (color ${folder.color ?? 'none'})` : ''
    lines.push(
      `folder ${folder.status}: ${folder.path}${color}${folder.error ? ` — ${folder.error}` : ''}`
    )
  }
  for (const change of result.changes) {
    const count = `${change.panes.length} session${change.panes.length === 1 ? '' : 's'}`
    const id = change.opId ? `  [${change.opId}]` : ''
    lines.push(
      `${change.status} ${change.kind}: ${count}${id}${change.error ? ` — ${change.error}` : ''}`
    )
  }
  if (result.changes.length === 0) {
    lines.push('Nothing to change.')
  }
  for (const skip of result.skipped) {
    lines.push(`skipped ${skip.pane} (${skip.kind}): ${skip.reason}`)
  }
  lines.push(formatFocus('Sidebar now', result.focus.before))
  lines.push(formatFocus(result.dryRun ? 'Sidebar after' : 'Sidebar now after', result.focus.after))
  if (!result.dryRun && result.changes.some((change) => change.status === 'applied')) {
    lines.push('The OmniConsole window shows one notice with Undo for all of it.')
  }
  if (result.auditError) {
    lines.push(`warning: ${result.auditError}`)
  }
  return lines.join('\n')
}

async function organize(
  { client, flags, json }: HandlerContext,
  plan: SessionOrganizePlan,
  apply: boolean
): Promise<void> {
  if (client.isRemote) {
    throw new RuntimeClientError(
      'permission_denied',
      'Sessions can only be organized by the omni CLI on the computer running OmniConsole.'
    )
  }
  const { reason, request } = sessionProvenance(flags)
  const sent: SessionOrganizePlan = {
    ...plan,
    ...(reason ? { reason } : {}),
    ...(request ? { request } : {})
  }
  let response
  try {
    response = await client.call<SessionOrganizeResult>(SESSION_ORGANIZE_RPC, { plan: sent, apply })
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'unsupported',
        'This OmniConsole cannot organize sessions yet; update it. Nothing changed.'
      )
    }
    throw error
  }
  printResult(response, json, formatOrganizeResult)
  const { result } = response
  if (
    apply &&
    result.changes.length > 0 &&
    result.changes.every((change) => change.status !== 'applied')
  ) {
    throw new RuntimeClientError('session_organize_failed', 'Nothing was applied; see above.')
  }
  if (apply && result.changes.length === 0 && result.skipped.length > 0) {
    throw new RuntimeClientError(
      'session_organize_failed',
      `Nothing changed: ${result.skipped[0]!.reason}`
    )
  }
}

function perPane(flags: Flags, entry: Omit<SessionOrganizeEntry, 'pane'>): SessionOrganizePlan {
  return { changes: panesOf(flags).map((pane) => ({ pane, ...entry })) }
}

function applyUnlessDryRun(flags: Flags): boolean {
  return sessionProvenance(flags).dryRun !== true
}

export const SESSION_ORGANIZE_HANDLERS: Record<string, CommandHandler> = {
  'session tag': async (context) => {
    const addTags = list(getOptionalStringFlag(context.flags, 'add'))
    const removeTags = list(getOptionalStringFlag(context.flags, 'remove'))
    if (addTags.length === 0 && removeTags.length === 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass --add <tag>[,<tag>...] and/or --remove <tag>[,<tag>...].'
      )
    }
    const entry = {
      ...(addTags.length > 0 ? { addTags } : {}),
      ...(removeTags.length > 0 ? { removeTags } : {})
    }
    await organize(context, perPane(context.flags, entry), applyUnlessDryRun(context.flags))
  },
  'session hide': async (context) =>
    organize(context, perPane(context.flags, { hide: true }), applyUnlessDryRun(context.flags)),
  'session unhide': async (context) =>
    organize(context, perPane(context.flags, { hide: false }), applyUnlessDryRun(context.flags)),
  'session snooze': async (context) => {
    const snooze = snoozeOf(getRequiredStringFlag(context.flags, 'until'))
    await organize(context, perPane(context.flags, { snooze }), applyUnlessDryRun(context.flags))
  },
  'session organize': async (context) => {
    const { flags } = context
    const apply = flags.get('apply') === true
    if (apply && flags.get('dry-run') === true) {
      throw new RuntimeClientError('invalid_argument', 'Pass --apply or --dry-run, not both.')
    }
    const plan = parseOrganizePlan(readPlanText(getRequiredStringFlag(flags, 'plan')))
    await organize(context, plan, apply)
  }
}
