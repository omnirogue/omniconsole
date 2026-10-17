import { graphEvidenceLocation, type GraphEvidenceCheck } from './graph-evidence-check'
import type { GraphItem } from './graph-items'
import { graphPlural } from './graph-plan-types'
import { graphPreVerifyLines } from './graph-pre-verify'

/** The list format a finder with `list.evidence` is asked for; evidence rules 2 add the search. */
export function graphEvidenceListInstruction(
  max: number,
  preVerify?: boolean,
  includeFix = false
): string {
  return [
    `Return your results as a list of at most ${max} items: title, detail, location (path:line, or "" when there is none), severity ("none" when it does not apply), ${includeFix ? 'excerpt, trigger and fix' : 'excerpt and trigger'}.`,
    'excerpt: the code at that location, copied exactly as it is in the file, character for character (at most 1,200 characters; join parts that are apart with "..."), or "" when the result is not about code. The app checks every quote against the file before any reviewer sees it, so never retype or paraphrase code from memory.',
    'trigger: one line saying what makes it happen.',
    ...(includeFix
      ? [
          'fix: the concrete fix or smallest next step to test the proposal, at most 600 characters.'
        ]
      : []),
    ...(preVerify
      ? [
          'A result that says something is absent (not wired, never called, missing, does not exist) must give in its detail the search that found nothing, as `rg <pattern> <path>`. The app re-runs it, and any match goes to the reviewers.'
        ]
      : []),
    'Return an empty list if there is nothing real to report.'
  ].join('\n')
}

/** The report's plain words for the app's check; none for a result it found nothing to say on. */
export function graphEvidencePhrase(check: GraphEvidenceCheck | undefined): string | undefined {
  const flags = check?.preVerify?.flags.length ?? 0
  const pre = check?.preVerify?.dropped
    ? 'dropped before review: no file it cites exists'
    : flags
      ? `app check flagged ${graphPlural(flags, 'problem')}`
      : undefined
  const quote = quotePhrase(check)
  return quote && pre ? `${quote} · ${pre}` : (quote ?? pre)
}

function quotePhrase(check: GraphEvidenceCheck | undefined): string | undefined {
  switch (check?.status) {
    case 'found':
      return 'quote checked in the file'
    case 'moved':
      return 'quote found elsewhere in the file'
    case 'missing':
      return 'quote not found in the file'
    case 'unreadable':
      return 'file could not be read'
    case 'unquoted':
      return 'no quote given'
    case 'not-code':
    case undefined:
      return undefined
  }
}

function checkSentence(check: GraphEvidenceCheck, named: number | undefined): string {
  switch (check.status) {
    case 'found':
      return `the quote was found in the file at line ${check.line}, at or near the line the finder gave.`
    case 'moved':
      return `the quote was found in the file at line ${check.line}, not near line ${named} that the finder gave.`
    case 'missing':
      return 'the quoted code was not found in the file (whitespace ignored). Weigh that, but judge the result on the real code below.'
    case 'unreadable':
      return 'the file could not be read, so the quote is unchecked; that says nothing for or against the result.'
    case 'unquoted':
      return 'the finder gave no quote, so nothing was checked against the file.'
    case 'not-code':
      return 'the result names no path:line, so there was no code to check.'
  }
}

const fenced = (text: string) => {
  const fence = '`'.repeat(
    Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1))
  )
  return `${fence}\n${text}\n${fence}`
}

/** What a reviewer starts from: the finder's quote and trigger, the app's check, the real lines. */
export function graphEvidencePack(item: GraphItem, fence?: (written: string) => string): string {
  const check = item.evidence
  if (!check) {
    return ''
  }
  const location = graphEvidenceLocation(check.location ?? item.location)
  const excerpt = check.excerpt ?? item.excerpt
  // What the finder wrote is model text; in a run that reads pages it is fenced apart from the app's.
  const written = [
    `Trigger: ${item.trigger ?? 'not given'}`,
    ...(check.location ? [`Checked quote location: ${check.location}`] : []),
    ...(excerpt ? [`The finder's quote:\n${fenced(excerpt)}`] : [])
  ]
  const pre = check.preVerify
  // Its citations and searches are the finder's words too, so in a fence they join its block.
  const checked = pre
    ? [
        ...pre.flags.map((flag) => `Flagged: ${flag}`),
        ...graphPreVerifyLines(pre).map((line) => `- ${line}`)
      ]
    : []
  const inFence = checked.length ? [...written, 'App check of its citations:', ...checked] : written
  const flagged = pre?.flags.length
    ? `${graphPlural(pre.flags.length, 'problem')} flagged. Weigh each, but judge the result on the real code.`
    : 'nothing flagged.'
  return [
    'Evidence pack (start from it; you may open more files where it does not settle the result):',
    ...(fence ? [fence(inFence.join('\n'))] : written),
    ...(check.status === 'not-code' && pre
      ? []
      : [`App check: ${checkSentence(check, location?.line)}`]),
    ...(pre
      ? [
          `App check of its citations and absence searches, before any reviewer: ${flagged}`,
          ...(fence ? [] : checked)
        ]
      : []),
    ...(check.context && location
      ? [
          // The path is the finder's own words: outside a fence the app names no model text.
          `The real lines of ${fence ? 'the file it names' : (pre?.citations[0]?.at ?? location.file)} around line ${check.line}:\n${fenced(check.context)}`
        ]
      : [])
  ].join('\n')
}
