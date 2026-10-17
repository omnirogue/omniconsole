import { readablePackageFileName } from './session-handoff-summary'

export type HandoffPackageFileNames = { summary: string; transcript: string }

const SECOND = 1000
const SECONDS_TRIED = 120

/**
 * The generated files' names. A later review round keeps round one's, so the summary posts as the
 * next version of the same file; names that clash with other work in the chosen folder move to the
 * next free second instead of a refused save. The same bytes are no clash: a retry reuses its files.
 */
export async function handoffPackageFileNames(args: {
  topic: string
  keptSummaryName?: string
  clashes: (names: HandoffPackageFileNames) => Promise<boolean>
  now?: Date
}): Promise<HandoffPackageFileNames> {
  if (args.keptSummaryName?.startsWith('Summary - ')) {
    return {
      summary: args.keptSummaryName,
      transcript: args.keptSummaryName.replace(/^Summary/, 'Conversation transcript')
    }
  }
  const start = args.now ?? new Date()
  let names = namesAt(args.topic, start)
  for (let second = 1; second <= SECONDS_TRIED; second += 1) {
    if (!(await args.clashes(names))) {
      break
    }
    names = namesAt(args.topic, new Date(start.getTime() + second * SECOND))
  }
  return { ...names, ...(args.keptSummaryName ? { summary: args.keptSummaryName } : {}) }
}

function namesAt(topic: string, at: Date): HandoffPackageFileNames {
  return {
    summary: readablePackageFileName('Summary', topic, at),
    transcript: readablePackageFileName('Conversation transcript', topic, at)
  }
}
