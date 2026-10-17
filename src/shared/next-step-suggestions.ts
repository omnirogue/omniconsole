/**
 * Suggested next steps: what the AI proposes after a turn (or before a session starts), and the
 * person's one-click answer to it — run some, all, none, or save for later.
 *
 * A suggestion is a PRESENTATION, never business state: accepting one sends its prompt as the
 * person's own message through the conversation's existing door (the prompt queue), and saving
 * one files a Proposed card only on the person's click. Nothing here runs by itself; "Keep going"
 * is a per-conversation opt-in the person turns on.
 */

import type { ConversationSource } from './conversation-source'

export const NEXT_STEP_SUGGESTION_MAX = 12
export const NEXT_STEP_TITLE_MAX = 120
export const NEXT_STEP_PROMPT_MAX = 4_000
export const NEXT_STEP_WHY_MAX = 240

/** `safe` = no warning sign found (`nextStepRiskOf`); `risky` steps are never pre-selected and never in "Run all safe". */
export type NextStepRisk = 'safe' | 'risky'

export type NextStepKind =
  | 'continue'
  | 'verify'
  | 'fix'
  | 'review'
  | 'ship'
  | 'follow-up'
  | 'ask'
  | 'other'

export type NextStepSuggestion = {
  /** Stable within its set. */
  id: string
  /** What the row reads; one line. */
  title: string
  /** Exactly what is sent to the agent when accepted. */
  prompt: string
  why?: string
  risk: NextStepRisk
  kind: NextStepKind
  /** `jev`: JEV raised this step to risky. JEV never lowers a risk. */
  riskReason?: 'jev'
  /** JEV's 0–1 reading that running this step leaves the workspace or reaches people, money or access. */
  jevRisk?: number
  /**
   * The agent asked or offered this step itself ("Should I …?", "If you want, I can …"): the
   * person's "Yes" is their explicit answer, one click, whatever the risk label.
   */
  offered?: true
  /**
   * The reply named this option as the one to do ("I can write items 1, 2 and 4 now"): the tray
   * ticks it in advance. A risky step is still never pre-ticked.
   */
  preselected?: true
  /**
   * Options the reply offered together as one list ("Which of these should I do?"). Choosing
   * several from one group sends them as ONE message, not one turn each.
   */
  optionGroup?: string
}

export const NEXT_STEP_OPTION_GROUP_MAX = 64

/** How a parsed step's prompt opens: the reply's own wording follows. */
export const NEXT_STEP_STEP_PROMPT_LEAD = 'Please go ahead with this next step you suggested: '
/** How an option from a menu the reply offered opens. */
export const NEXT_STEP_OPTION_PROMPT_LEAD = 'Please go ahead with this option you offered: '
const OPTIONS_PROMPT_LEAD = 'Please go ahead with these options you offered, together:'

/**
 * One message for several options chosen from one offered menu, in the menu's order: the agent
 * can plan them as one piece of work instead of receiving them one turn at a time.
 */
export function combinedNextStepOptionsPrompt(steps: readonly NextStepSuggestion[]): string {
  const lines = steps.flatMap((step, index) => {
    const body = step.prompt.startsWith(NEXT_STEP_OPTION_PROMPT_LEAD)
      ? step.prompt.slice(NEXT_STEP_OPTION_PROMPT_LEAD.length)
      : step.prompt.startsWith(NEXT_STEP_STEP_PROMPT_LEAD)
        ? step.prompt.slice(NEXT_STEP_STEP_PROMPT_LEAD.length)
        : step.prompt
    const [first = step.title, ...rest] = body.split('\n')
    return [`${index + 1}. ${first}`, ...rest.map((line) => `   ${line}`)]
  })
  const text = [OPTIONS_PROMPT_LEAD, ...lines].join('\n')
  return text.length > NEXT_STEP_PROMPT_MAX
    ? `${text.slice(0, NEXT_STEP_PROMPT_MAX - 1).trimEnd()}…`
    : text
}

/**
 * `parsed` = read from the agent's own reply, no model call. `ai` = a one-shot suggester call after
 * a finished turn. `start` = offered before a session's first message.
 */
export type NextStepSuggestionOrigin = 'parsed' | 'ai' | 'start'

export type NextStepSuggestionSetStatus =
  | 'generating'
  | 'pending'
  | 'accepted'
  | 'dismissed'
  | 'superseded'
  | 'failed'

export type NextStepSuggestionSet = {
  id: string
  /** Absent only on a `start` set offered before any conversation exists. */
  conversation?: ConversationSource
  /** The workspace a `start` set belongs to. */
  worktreeId: string
  /** Identity of the finished turn this set answers; one set per turn. */
  turnKey: string
  origin: NextStepSuggestionOrigin
  createdAt: number
  status: NextStepSuggestionSetStatus
  suggestions: NextStepSuggestion[]
  /** Which model wrote an `ai`/`start` set, as the runner reported it. */
  model?: string
  /** Plain words when generation failed, or why an open set was settled without an answer. */
  error?: string
  /** A `parsed` set: the reply it was read from, so a client can tell it is for its own reply. */
  messageId?: string
  /** Who ordered the steps: JEV when it was sure, else the writer's own order. Absent: JEV not asked. */
  rankedBy?: 'jev' | 'model'
  /** JEV's 0–1 score per suggestion id (the mean of its four criteria); advisory. */
  jevScores?: Record<string, number>
}

export type NextStepDecision =
  | {
      action: 'run'
      suggestionIds: string[]
      auto?: boolean
      /** Keep going ran a step that pauses ads, allowed without asking (Sal, 2026-09-26). */
      adPause?: boolean
    }
  | { action: 'save'; suggestionIds: string[] }
  | { action: 'dismiss' }

/** One line per decision in the local log that later tunes the suggester. */
export type NextStepDecisionRecord = {
  at: number
  setId: string
  origin: NextStepSuggestionOrigin
  model?: string
  offered: { id: string; title: string; risk: NextStepRisk; kind: NextStepKind }[]
  decision: NextStepDecision
}

// The label decides only what the bulk "Run all safe" button includes; every prompt is shown and
// any single step runs with one click, and sessions keep their own permissions. No wording test
// can prove a step harmless, so "safe" means "no warning sign found": plain code work stays one
// click away in bulk, and anything with a sign of leaving the workspace, destroying data, touching
// credentials or the supply chain, or reaching people or money needs its own click.

// Shell and code: backticks, operators, substitutions, redirects, flags, env assignments, paths.
const COMMAND_SYNTAX: readonly RegExp[] = [
  /[`$]|&&|\|\||<\(|\|/,
  /;|(?:^|\s)(?:>|<|>>|2>)|\S>\S|>\s*[~./\w$"']/,
  /(?:^|\s)-{1,2}[A-Za-z0-9][\w-]*/,
  /\b[A-Z][A-Z0-9_]*=\S/,
  /(?:^|[\s'"(=])(?:~\/|\/[A-Za-z]|[A-Za-z]:\\|\\\\)/
]

// Checks that only read, and the project's own test/lint/build scripts, stay safe in bulk.
const READ_ONLY_COMMAND =
  /^(?:(?:please\s+)?(?:run|re-?run)\s+)?(?:git\s+(?:status|diff|log|show|blame|branch)(?:\s+[\w./@^~-]+)?|(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:test|tests|lint|typecheck|tc|tc:\w+|check|build|format|vitest)(?:\s+[\w./@:-]+)?)(?:\s+(?:and\s+)?(?:report|fix|summari[sz]e|show|list)\b.*)?\.?$/i

// A CLI tool or interpreter named with something after it. Plain-English homonyms (open, go,
// make, find, source, kill) are left out; their dangerous forms carry flags or paths.
const TOOL_WITH_ARGUMENT =
  /(?:^|[\s(])(?:git|npm|pnpm|yarn|npx|bunx?|pip3?|pipx|uvx?|poetry|conda|nix|docker|podman|kubectl|helm|terraform|aws|gcloud|az|gh|brew|apt(?:-get)?|yum|dnf|pacman|cargo|rustup|python3?|node|tsx|ts-node|deno|ruby|perl|php|java|bash|sh|zsh|fish|pwsh|powershell|cmd|osascript|wscript|cscript|mv|cp|psql|mysql|sqlite3|mongo(?:sh)?|redis-cli|tee|xargs|sed|awk|net)\s+\S/i

// Tools that reach another machine, run as another user or destroy files: naming one is a sign.
const RISKY_TOOL_NAME =
  /\b(?:curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|socat|telnet|ftp|sudo|doas|rm|rmdir|del|rd|unlink|dd|mkfs|shred|srm|chmod|chown|icacls|pkill|killall|launchctl|crontab|systemctl|iex|iwr|irm)\b/i

// Signs that a step leaves the workspace, can't be undone, or touches people, money or access.
const WARNING_SIGN = new RegExp(
  String.raw`\b(?:` +
    [
      // shipping, remotes, history
      String.raw`deploy\w*|releas\w*|publish\w*|ship(?:s|ped|ping)?|roll(?:s|ed|ing)? out|rollout|go(?:es|ing)? live|prod|production|staging|push\w*|merg\w*|rebas\w*|cherry-pick\w*|force-push\w*|force push\w*|reset --hard|hard reset|rewrit\w* (?:the )?(?:git )?history|amend\w*`,
      // people and exfiltration
      String.raw`send\w*|e-?mails?|repl(?:y|ies|ied|ying) to|message (?:the|to|them|him|her)|notif\w*|slack|sms|tweet\w*|post(?:s|ed|ing)? (?:it|this|that|them|publicly|online|to)|publicly|exfiltrat\w*|usb|external drive|upload\w*|leak\w*`,
      // money
      String.raw`payments?|pay(?:s|ing)? (?:for|the)|purchas\w*|buy(?:s|ing)?|order(?:s|ed|ing)? (?:a|an|the)|refund\w*|charg(?:e|es|ed|ing) (?:the|a|an|their|my|our)|invoices?|billing|subscriptions?|stripe`,
      // credentials and access
      String.raw`credentials?|passwords?|passphrases?|secrets?|tokens?|api[ -]?keys?|private keys?|ssh keys?|authorized_keys|id_(?:rsa|dsa|ecdsa|ed25519)\w*|kubeconfig|netrc|npmrc|pypirc|environment variables?|env vars?|keychains?|certificates?|oauth|sudo|admin\w*|root access|as root|permissions?|privileges?|writable|world-readable|iam|access keys?`,
      // supply chain, guards and persistence
      String.raw`install\w*|uninstall\w*|dependenc(?:y|ies)|package\.json|lock ?files?|registry|postinstall|preinstall|prepare script|lifecycle scripts?|git hooks?|pre-commit|pre-push|pre-receive|husky|hooksPath|launch ?agents?|login items?|startup items?|reverse shell|bind shell|backdoor|persistence|base64|payloads?|obfuscat\w*|download\w*|installers?|(?:fetch|get|grab)\w* [^.;\n]{0,40}(?:and )?(?:run|execut)\w*`,
      // infrastructure and data stores
      String.raw`infrastructure|terraform|kubernetes|clusters?|dns|firewall|databases?|db|sql|migrations?|backups?|buckets?|volumes?|disks?`
    ].join('|') +
    String.raw`)\b`,
  'i'
)

// Editing CI, pipelines or guard files is a sign; reading their output is not.
const GUARD_EDIT =
  /\b(?:modif|updat|chang|edit|disabl|replac|rewrit|creat|add|remov|delet|skip|bypass|turn\w* off)\w*\b[^.;\n]{0,50}\b(?:ci|workflows?|pipelines?|github actions?|jenkinsfile|dockerfile|makefile|hooks? files?|\.git|\.github|gitlab-ci|circleci)\b/i

// Destroying things beyond code: a destroy verb together with a file, folder, data or storage word.
const DESTROY_VERB =
  /\b(?:delet\w*|remov\w*|wip(?:e|es|ed|ing)|eras\w*|purg\w*|destroy\w*|discard\w*|prun(?:e|es|ed|ing)|trash\w*|drop(?:s|ped|ping)?|empt(?:y|ies|ied|ying) (?:the|all|every|my|our|your|this|that)|overwrit\w*|truncat\w*|clear(?:s|ed|ing)?|clean(?:s|ed|ing)?|nuk\w*|zero(?:es|ed|ing)? out|blank(?:s|ed|ing)?|get(?:ting)? rid of|replac\w* [^.;\n]{0,40}\b(?:blank|empty|nothing))\b/i
const BEYOND_CODE =
  /\b(?:files?|folders?|director(?:y|ies)|dirs?|everything|all|every|untracked|data|dataset|tables?|records?|rows?|logs?|caches?|branch(?:es)?|tags?|repos?|repositor(?:y|ies)|worktrees?|workspaces?|history|commits?|users?|accounts?|customers?|clients?|emails?|messages?|storage|queues?|documents|desktop|home|drive|ledger|stash|changes|uncommitted|unstaged|working (?:tree|copy)|artifacts?)\b/i

// Files and addresses, checked token by token (linear time, no nested quantifiers).
// Key material and certificates are never repository files.
const KEY_FILE = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i
const REPO_FILE =
  /\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|go|rs|rb|java|kt|swift|css|scss|less|vue|svelte|html|md|mdx|txt|json|ya?ml|toml|svg)$/i
const NOT_A_FILE = /^(?:e\.g|i\.e|etc|vs|v?\d+(?:\.\d+)+)$/i
const HOST_SUFFIX =
  /\.(?:com|net|org|io|dev|app|ai|co|us|uk|de|me|sh|xyz|cloud|site|tech|info|biz|gg|so|to)$/i
const IP_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/

function tokensOf(text: string): string[] {
  return text
    .split(/[\s,;()'"<>{}]+/)
    .map((token) => token.replace(/[.:!?]+$/, ''))
    .filter(Boolean)
}

function tokenIsAllowed(token: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
    let url: URL
    try {
      url = new URL(token)
    } catch {
      return false
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    return /^https?:$/.test(url.protocol) && loopback && !url.username && !url.password
  }
  const head = token.split('/')[0]!.replace(/:\d+$/, '')
  if (IP_LITERAL.test(head)) {
    return head === '127.0.0.1'
  }
  if (HOST_SUFFIX.test(head) || head.includes('@')) {
    return false
  }
  // Dotfiles and dot-directories are configuration, credentials or guards (.env, .netrc, .git/).
  if (/(?:^|\/)\.[\w-]/.test(token) && !/^\.{1,2}\/[\w-]/.test(token)) {
    return false
  }
  const lastDot = token.lastIndexOf('.')
  if (KEY_FILE.test(token)) {
    return false
  }
  if (lastDot > 0 && /^[A-Za-z]\w{0,7}$/.test(token.slice(lastDot + 1))) {
    return REPO_FILE.test(token) || NOT_A_FILE.test(token)
  }
  return true
}

function hasWarningSign(text: string): boolean {
  return (
    (!READ_ONLY_COMMAND.test(text.trim()) &&
      (COMMAND_SYNTAX.some((pattern) => pattern.test(text)) || TOOL_WITH_ARGUMENT.test(text))) ||
    RISKY_TOOL_NAME.test(text) ||
    WARNING_SIGN.test(text) ||
    GUARD_EDIT.test(text) ||
    (DESTROY_VERB.test(text) && BEYOND_CODE.test(text)) ||
    !tokensOf(text).every(tokenIsAllowed)
  )
}

export function nextStepRiskOf(text: string, claimed?: NextStepRisk): NextStepRisk {
  return claimed === 'risky' || !text.trim() || hasWarningSign(text) ? 'risky' : 'safe'
}

/** A set whose ids repeat cannot be answered: one tick could stand for two different prompts. */
export function hasUniqueNextStepIds(set: { suggestions: readonly { id: string }[] }): boolean {
  return new Set(set.suggestions.map((suggestion) => suggestion.id)).size === set.suggestions.length
}

/** The suggestions "Run all safe" sends, in their offered order. */
export function safeNextSteps(
  set: Pick<NextStepSuggestionSet, 'suggestions'>
): NextStepSuggestion[] {
  return set.suggestions.filter((suggestion) => suggestion.risk === 'safe')
}
