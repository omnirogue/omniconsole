// Legacy decoder only. Builds before 2026-09-21 wrapped a native-chat message that looked like a
// next-step request in this envelope, with a filing guide appended. Next steps are now set through
// the UI and chat messages go out unmodified, so nothing writes the envelope any more; persisted
// transcripts and resumed sessions still contain it, and every reader must show the typed words.
const SOURCE_MARKER = '<!-- omni-outcome-source-v1 -->\n<!-- omni-next-step-chat-v1:'
const CONTEXT_MARKER = '\n\nAdditional task context (context only, not the user request):\n'
const SUPPORTED_CLIS = ['omni', 'omni-dev', 'omni-ide', 'omni.cmd']
const SOURCE_LIMIT = 256_000

/** The exact guide those builds appended; frozen so an envelope is only decoded when unaltered. */
export function legacyNextStepChatFilingGuide(cli: string): string {
  return `<!-- omni-outcome-source-v1 -->\nNext-step request, not work to do now. Run \`${cli} outcome context --json\` here now. Follow its schema and instructions: reviewers become review obligations; resolved people become human-handoff outcomes with no agent actions; an explicit saved/ended session uses sessionFinish. Preserve requested files, transcript consent and every existing obligation. Each agent action quotes an exact excerpt (12+ chars) of the user's message. Ask ONE question only for an unresolved recipient, files or agent. Commit with \`${cli} outcome commit\`; the host owns later delivery and completion. Do not perform it now. Report any refused obligation accurately. Reply with what you filed and that it is adjustable under ＋ Next actions.`
}

/** Undefined means ordinary text; null means a malformed or unknown generated envelope. */
export function nextStepChatSubmissionSource(prompt: string): string | null | undefined {
  if (!prompt.startsWith(SOURCE_MARKER)) {
    return undefined
  }
  const header =
    /^<!-- omni-outcome-source-v1 -->\n<!-- omni-next-step-chat-v1:(\d{1,6}) -->\n/.exec(prompt)
  if (!header) {
    return null
  }
  const length = Number(header[1])
  if (length > SOURCE_LIMIT) {
    return null
  }
  const source = prompt.slice(header[0].length, header[0].length + length)
  const suffix = prompt.slice(header[0].length + length)
  // An envelope carried the filing guide only for next-step intent, so context
  // may follow the source directly. Both shapes decode; anything else is either
  // tampered with or from a version this one does not know.
  const validSuffix =
    suffix.startsWith(CONTEXT_MARKER) ||
    SUPPORTED_CLIS.some((cli) => {
      const guide = `\n\n${legacyNextStepChatFilingGuide(cli)}`
      return suffix === guide || suffix.startsWith(`${guide}${CONTEXT_MARKER}`)
    })
  return validSuffix && source.trim() && source.length === length ? source : null
}
