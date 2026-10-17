// Only complete prose citations qualify; commands, absolute paths and executable files do not.
const SEGMENT = String.raw`[a-z0-9_][a-z0-9_.-]*`
const SEPARATOR = String.raw`[\\/]`
const ARTIFACT = String.raw`(?:${SEGMENT}${SEPARATOR})*(?:${SEGMENT}\.(?:md|txt|jsonl?|log)|${SEGMENT}${SEPARATOR})`
const TOKEN = `(?:\`${ARTIFACT}\`|${ARTIFACT})`
const CITATION = new RegExp(
  String.raw`(^[ \t]*|[.!?][ \t]+)Evidence:[ \t]+(${TOKEN}(?:(?:[ \t]*,[ \t]*(?:and[ \t]+)?|[ \t]+and[ \t]+)${TOKEN})*)(?=[.!?](?:[ \t]|$)|[ \t]*$)`,
  'gim'
)
const EXECUTABLE_SEGMENT =
  /\.(?:sh|bash|zsh|fish|command|bat|cmd|ps1|py|js|mjs|cjs|exe|app)(?:[\\/.`]|$)/i
const EXECUTION_REQUEST =
  /\b(?:run|execute|invoke|source)\b|\b(?:follow|perform|carry[ -]+out)(?:[ -]+(?:the|these|those|all))?[ -]+(?:instructions|steps|commands)\b/i
const SHELL_LINE =
  /^[ \t]*(?:please[ \t]+)?(?:[$>][ \t]*)?`?(?:bash|sh|zsh|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh|python[23]?|node|ruby|perl|env|exec)\b/im

const RECORDED_REFERENCE = new RegExp(
  String.raw`(^|[.!?;][ \t]+)(?:the |your |our )?(?:request and )?(?:owner )?(?:refs|references) are recorded in ((?:~[\\/])?${ARTIFACT})[.!?]?(?=[ \t]*(?:\n|$))`,
  'gim'
)
const BRANCH = String.raw`[a-z0-9_][a-z0-9_-]*(?:/[a-z0-9_][a-z0-9_-]*)+`
const BRANCH_NOUN = new RegExp(
  String.raw`\b(about your )(${BRANCH})(?=:[ \t]+)|\b(the branch )(${BRANCH})(?=[,)]|[ \t]+(?:changes|edits)\b)`,
  'gi'
)
const CLOSED_VERIFY =
  /\bre-run verify(?=\.(?:\s|$)|, keeping (?:the )?[\w/]+(?: and [\w/]+)* paths intact\.(?:\s|$))/gi
const REFERENCE_EXECUTION =
  /\b(?:run|execute|invoke|follow|perform|apply|implement|use|do|proceed|complete|finish|continue|start|begin|handle|action|address|resume|redo|repeat)\b|\b(?:carry[ -]+out|go ahead|act on|make it happen|take care of|work through|deal with|get on with|sort out|see to|go through)\b/i
const REFERENCE_BACKREFERENCE =
  /\b(?:instructions?|steps?|commands?|directions?)\b|\bwhat it says\b|\b(?:recorded|described|detailed|listed|noted|set out)[ \t]+(?:there|above|below|in it)\b/i
const SOURCE_COMMAND =
  /(?:^|[.!?;\n])[ \t]*(?:please[ \t]+)?source\b|\b(?:then|and|to)[ \t]+source\b|\bsource[ \t]+(?:[^\s]+[\\/.]|the\b|this\b|that\b)|(?:^|\n)[ \t]*\.[ \t]+\S/i

function canProjectRecordedReferences(text: string): boolean {
  const actions = text.replace(CLOSED_VERIFY, '')
  return !(
    /[`|<>$&]|~~~|--|\b(?:bash|zsh|fish|sh|cmd|powershell|pwsh|python[23]?|node|ruby|perl|eval|exec)\b/i.test(
      actions
    ) ||
    REFERENCE_EXECUTION.test(actions) ||
    REFERENCE_BACKREFERENCE.test(actions) ||
    SOURCE_COMMAND.test(actions)
  )
}

/** Only proven noun references change category matching; execution and submitted text stay intact. */
export function questionReferenceProjections(text: string): { deploy: string; deleteData: string } {
  if (!canProjectRecordedReferences(text)) {
    return { deploy: text, deleteData: text }
  }
  return {
    deploy: text.replace(RECORDED_REFERENCE, (whole: string, prefix: string, path: string) =>
      EXECUTABLE_SEGMENT.test(path) ? whole : `${prefix}References are recorded in [artifact].`
    ),
    deleteData: text.replace(
      BRANCH_NOUN,
      (
        _whole: string,
        aboutPrefix: string | undefined,
        _aboutBranch: string | undefined,
        branchPrefix: string | undefined,
        _branchName: string | undefined
      ) => `${aboutPrefix ?? branchPrefix}[branch reference]`
    )
  }
}

/** Deployment-topic scan only: the sent body and every other hard-stop scan retain the original. */
export function questionWithoutEvidenceCitations(text: string): string {
  // A code fence may be an executable request even when its contents resemble a citation.
  if (/```|~~~/.test(text)) {
    return text
  }
  const projected = text.replace(CITATION, (whole: string, prefix: string, references: string) =>
    EXECUTABLE_SEGMENT.test(references) ? whole : `${prefix}Evidence: [artifact references]`
  )
  // Instructions to execute the cited material must retain its deployment keywords.
  return EXECUTION_REQUEST.test(projected) || SHELL_LINE.test(projected) ? text : projected
}
