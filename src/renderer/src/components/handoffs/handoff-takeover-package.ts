import { translate } from '@/i18n/i18n'
import { workflowData } from '@/lib/console-workflow-client'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { handoffPackageOf } from '../../../../shared/console-handoff-disposition-reference'
import { handoffApi } from './handoff-client'

/** Where each part of a received package landed in the folder the session starts in. */
export type SavedHandoffPackage = {
  summary: string | null
  transcript: string | null
  work: string[]
  /** Files that could not be saved, each with the reason the person would read. */
  missing: string[]
}

/** Saves everything the sender sent into the folder, so the AI starts beside the work itself. */
export async function saveHandoffPackage(
  detail: HandoffDetail,
  folder: string
): Promise<SavedHandoffPackage> {
  const received = workflowData(
    await handoffApi().materialize({
      threadId: detail.thread.id,
      workspacePath: folder,
      filesOnly: true
    })
  )
  const saved = new Map<string, string>()
  const missing: string[] = []
  for (const file of received.files.files) {
    if (file.outcome !== 'refused' && file.path) {
      saved.set(file.name, file.path)
    } else {
      missing.push(`${file.name}: ${file.reason ?? ''}`.replace(/: $/, ''))
    }
  }
  const { summary, transcript, work } = handoffPackageOf(detail)
  return {
    summary: (summary && saved.get(summary.name)) ?? null,
    transcript: (transcript && saved.get(transcript.name)) ?? null,
    work: work.flatMap((file) => saved.get(file.name) ?? []),
    missing
  }
}

/** The lines that tell the AI where the saved package is and in which order to read it. */
export function savedPackageBrief(saved: SavedHandoffPackage): string[] {
  const quoted = (paths: readonly string[]) => paths.map((path) => JSON.stringify(path)).join(', ')
  if (
    !saved.summary &&
    !saved.transcript &&
    saved.work.length === 0 &&
    saved.missing.length === 0
  ) {
    return []
  }
  return [
    translate(
      'handoffs.takeoverSaved',
      'Everything the sender sent is saved in this folder. You are taking this work over from another conversation.'
    ),
    ...(saved.summary
      ? [
          translate('handoffs.takeoverSummary', 'Read this first — summary: {{path}}', {
            path: JSON.stringify(saved.summary)
          })
        ]
      : []),
    ...(saved.transcript
      ? [
          translate(
            'handoffs.takeoverTranscript',
            'The full conversation (what was asked, tried and decided), for reference: {{path}}',
            { path: JSON.stringify(saved.transcript) }
          )
        ]
      : []),
    ...(saved.work.length > 0
      ? [
          translate('handoffs.takeoverWork', 'Work files: {{files}}', {
            files: quoted(saved.work)
          })
        ]
      : []),
    ...(saved.missing.length > 0
      ? [
          translate(
            'handoffs.takeoverMissing',
            'Not saved (say so before relying on them): {{files}}',
            {
              files: saved.missing.join('; ')
            }
          )
        ]
      : [])
  ]
}
