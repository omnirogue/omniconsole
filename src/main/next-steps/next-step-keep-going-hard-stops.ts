/**
 * What Keep going never runs by itself (Sal, 2026-09-23): sessions run in Bypass and are trusted,
 * so ordinary steps go ahead whatever their risk label; only these hard stops need the person.
 * A hit stops Keep going; the person can still run the step with one click.
 */

import type { NextStepAdPauses } from '../../shared/next-step-ad-pauses'
import type { NextStepKeepGoingStopReason } from '../../shared/next-step-keep-going'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import {
  questionReferenceProjections,
  questionWithoutEvidenceCitations
} from '../../shared/question-evidence-citations'

export type HardStopCategory =
  | 'ad-spend'
  | 'ad-enterprise'
  | 'ad-campaign-pause'
  | 'ad-pause'
  | 'deploy'
  | 'shared-branch'
  | 'delete-data'
  | 'history'
  | 'send'
  | 'payment'
  | 'credentials'

export type HardStop = { reason: NextStepKeepGoingStopReason; category: HardStopCategory }

// Branches other people build on; a push or merge into one is shared, a feature branch is not.
const SHARED = String.raw`(?:origin\/|upstream\/|refs\/heads\/)?(?:main|master|main-next|omni-brand|develop|prod-[\w.-]+|release[\w./-]*)\b`

const DESTROY = String.raw`(?:delet\w*|remov\w*|rm|unlink\w*|wip(?:e|es|ed|ing)|eras\w*|purg\w*|drop\w*|truncat\w*|empt(?:y|ies|ied|ying)|overwrit\w*|zero(?:e?s|ed|ing)? out|get(?:ting)? rid of|clean\w*|clear\w*)`
const DATA_TARGET = String.raw`(?:data|datasets?|databases?|dbs?|tables?|records?|rows?|backups?|buckets?|volumes?|untracked|everything|all (?:the )?files|home (?:dir|directory|folder)|documents|desktop|disks?|drives?)`

// Ads: changing spend or turning delivery on always needs Sal's yes. Pausing an ad or ad set is
// allowed by default (Sal, 2026-09-26) unless the person asked to approve pauses; a whole campaign
// or account is never paused ("we dont pause campaigns, we pause adsets"), nor is Enterprise.
// A following word that makes it copy, reporting or code ("ad copy", "campaign results") is not delivery.
const NOT_DELIVERY = String.raw`\b(?!-|\s+(?:copy|copies|text|headlines?|reports?|results?|metrics|stats|insights|analytics|data|ideas?|drafts?|scripts?|briefs?|blockers?|blocking|hoc|requests?|servers?|feature|flags?|components?|pages?|modules?|tests?|types?|schema|models?|api|endpoints?|services?|tables?|code|files?|docs?)\b)`
const AD_UNIT = String.raw`(?:ads?(?:[- ]?sets?|[- ]?groups?)?|adsets?|adgroups?)${NOT_DELIVERY}`
const AD_WHOLE = String.raw`(?:campaigns?|ad[- ]?accounts?)${NOT_DELIVERY}`
const AD_TARGET = String.raw`(?:${AD_WHOLE}|${AD_UNIT})`
// OmniRogue Enterprise ads are flagged for Sal, never paused: named, or its webinar campaigns.
const ENTERPRISE = String.raw`^(?=.*\b(?:enterprise|webinar(?:jam)?s?)\b)`
const AD_STOP_VERB = String.raw`(?:paus\w*|stop(?:s|ped|ping)?|disabl\w*|deactivat\w*|archiv\w*|kill\w*|(?:turn|switch)\w*\s+(?:back\s+)?off|shut\w*\s+(?:off|down))`
const AD_START_VERB = String.raw`(?:unpaus\w*|(?:re-?)?enabl\w*|(?:re-?)?activat\w*|unarchiv\w*|resum\w*|restart\w*|scal(?:e|es|ed|ing)(?:\s+(?:up|down|back))?|(?:turn|switch)\w*\s+(?:back\s+)?on)`
const AD_STOPPED = String.raw`(?:paused|stopped|disabled|deactivated|archived|turned (?:back )?off|switched off|shut (?:off|down))`
const AD_STARTED = String.raw`(?:unpaused|(?:re-?)?enabled|(?:re-?)?activated|unarchived|resumed|scaled|turned (?:back )?on|switched on)`
// Up to five words between verb and target, never a connector that starts another clause.
const AD_GAP = String.raw`(?:\s+(?!(?:after|before|when|once|until|while|if|then|and|or|to|with|for|in|of|from|into|by|that|which|who|about|reading|summar\w*|review\w*|report\w*|draft\w*|writ\w*|analy[sz]\w*|check\w*)\b)[\w'&#/$%.-]+){0,5}?\s+`
const BUDGET_VERB = String.raw`(?:rais\w*|increas\w*|lower\w*|decreas\w*|reduc\w*|cut(?:s|ting)?|chang\w*|adjust\w*|updat\w*|(?<!\bad[- ])set(?:s|ting)?|bump\w*|doubl\w*|halv\w*|tripl\w*|scal\w*|upp(?:ed|ing)|drop\w*|slash\w*|edit\w*|modif\w*|mov(?:e|es|ed|ing)|shift\w*|reallocat\w*|trim\w*|lift\w*)`
// Named only on ad platforms, so they need no other context.
const AD_BUDGET = String.raw`(?:(?:daily|lifetime|campaign|ad[- ]?set|adset|ad[- ]?group|ad)\s+(?:budgets?|bids?|spend)|bid[- ]?caps?|cost[- ]?caps?|bid strateg(?:y|ies)|spend(?:ing)?[- ](?:limits?|caps?)|target (?:cpa|roas)|roas (?:targets?|goals?)|ad spend)`
// Budgets and bids also exist in code (token, bundle, retry budgets): these need ad context.
const PLAIN_BUDGET = String.raw`(?:budgets?|bids?|spend(?:ing)?)`
const AD_CONTEXT = String.raw`(?:\b(?:ads?|ad[- ]?sets?|adsets?|ad[- ]?groups?|campaigns?|meta|facebook|fb|instagram|google ads|adwords|tiktok|snapchat|pinterest|linkedin ads|bing ads|microsoft ads|youtube ads|cpa|cpc|cpm|roas)\b|[$€£]\s?\d)`

/** "Pause the X campaign", "Turn the X ad sets off", "ad set 4 should be paused". */
function adDeliveryPatterns(
  verb: string,
  participle: string,
  ending: string,
  target: string,
  scope = ''
): RegExp[] {
  const within = scope ? `${scope}.*?` : ''
  return [
    new RegExp(String.raw`${within}\b${verb}${AD_GAP}(?:the\s+)?${target}`, 'i'),
    new RegExp(
      String.raw`${within}\b(?:turn|switch|shut)\w*(?:\s+[\w'&#/-]+){0,5}?\s+${target}(?:\s+[\w'&#/-]+){0,3}?\s+(?:back\s+)?${ending}\b`,
      'i'
    ),
    new RegExp(
      String.raw`${within}\b${target}[^\n.]{0,40}?\b(?:be|been|get|gets|got|getting|stay|stays|remain|remains|keep|kept)\s+(?:\w+\s+)?${participle}\b`,
      'i'
    )
  ]
}

const adStopPatterns = (target: string, scope = '') =>
  adDeliveryPatterns(AD_STOP_VERB, AD_STOPPED, '(?:off|down)', target, scope)

// Checked in this order: a step that pauses one thing and raises another's budget is `ad-spend`.
const HARD_STOPS: Record<HardStopCategory, readonly RegExp[]> = {
  'ad-spend': [
    ...adDeliveryPatterns(AD_START_VERB, AD_STARTED, 'on', AD_TARGET),
    new RegExp(String.raw`\b${BUDGET_VERB}${AD_GAP}${AD_BUDGET}\b`, 'i'),
    new RegExp(
      String.raw`\b${AD_BUDGET}\s+(?:increases?|decreases?|changes?|cuts?|bumps?|reductions?|raises?|adjustments?|updates?)\b`,
      'i'
    ),
    new RegExp(String.raw`^(?=.*${AD_CONTEXT}).*?\b${BUDGET_VERB}${AD_GAP}${PLAIN_BUDGET}\b`, 'i'),
    new RegExp(
      String.raw`^(?=.*${AD_CONTEXT}).*?\b${PLAIN_BUDGET}\s+(?:increases?|decreases?|changes?|cuts?|bumps?|reductions?|raises?|adjustments?)\b`,
      'i'
    ),
    // "daily budget $100 -> $150".
    new RegExp(
      String.raw`\b(?:${AD_BUDGET}|${PLAIN_BUDGET})\s+(?:from\s+)?[$€£]\s?\d[\d,.]*[kK]?\s*(?:→|->|to)\s*[$€£]?\s?\d`,
      'i'
    )
  ],
  'ad-enterprise': adStopPatterns(AD_TARGET, ENTERPRISE),
  'ad-campaign-pause': adStopPatterns(AD_WHOLE),
  'ad-pause': adStopPatterns(AD_UNIT),
  'shared-branch': [
    new RegExp(
      String.raw`\bpush\w*\b[^\n]{0,60}?(?:\s|:)(?:to\s+|into\s+|origin\s+|upstream\s+)?(?:the\s+)?${SHARED}`,
      'i'
    ),
    new RegExp(String.raw`\bmerg\w*\b[^\n]{0,60}?\b(?:into|to|onto)\s+(?:the\s+)?${SHARED}`, 'i'),
    /\bmerg\w*\s+(?:the\s+|this\s+|that\s+|my\s+)?(?:pr|pull request|mr|merge request)\b/i,
    /\bgh\s+pr\s+merge\b/i,
    // On a shared branch, then merging into it: "switch to main and merge the feature".
    new RegExp(
      String.raw`\b(?:switch|checkout|check out)\w*\s+(?:to\s+|onto\s+)?(?:the\s+)?${SHARED}[^\n]{0,120}?\bmerg\w*`,
      'i'
    ),
    /--force(?:-with-lease)?\b|\bforce[- ]?push\w*|\bpush\b[^\n]*\s(?:-f\b|\+\S)/i,
    /\bpush\b[^\n]*(?:--delete\b|\s-d\b|\s:[\w./-]+)|\bbranch\s+(?:-D|-d|--delete)\b|\btag\s+(?:-d|--delete)\b/i,
    new RegExp(String.raw`\b${DESTROY}\b[^\n.]{0,40}?\b(?:branch(?:es)?|tags?)\b`, 'i')
  ],
  deploy: [
    /\bkubectl\s+(?:apply|rollout|set\s+image)\b|\bhelm\s+(?:install|upgrade)\b|\bterraform\s+apply\b|\bdocker\s+push\b|\bfly\s+deploy\b|\bvercel\b[^\n]*--prod\b|\bnetlify\s+deploy\b|\bserverless\s+deploy\b|\b(?:aws|gcloud)\b[^\n]*\bdeploy\b/i,
    /\b(?:deploy\w*|releas(?:e|es|ed|ing)|publish\w*|ship(?:s|ped|ping)?|go(?:es|ing)? live|went live|roll(?:s|ed|ing)? (?:it |this |that |them )?out|rollouts?|prod|production|staging)\b/i
  ],
  'delete-data': [
    new RegExp(String.raw`\b${DESTROY}\b[^\n.]{0,60}?\b${DATA_TARGET}\b`, 'i'),
    new RegExp(String.raw`\b${DATA_TARGET}\b[^\n.]{0,40}?\b${DESTROY}\b`, 'i'),
    // Aimed at a path outside the workspace: absolute, home, parent, or the person's own folders.
    new RegExp(
      String.raw`\b${DESTROY}\b[^\n]{0,60}?(?:\s|^)(?:~|\.\.\/|\/(?!\/)[\w.-]|[A-Za-z]:\\)`,
      'i'
    ),
    /\bgit\s+clean\b|\brm\s+-\w*[rf]|\bfind\b[^\n]*\s-delete\b|\bdd\s+\w+=|\bmkfs\b|\bshred\b/i
  ],
  history: [
    /\breset\s+--hard\b|\bfilter-(?:branch|repo)\b|\bupdate-ref\s+-d\b|\breflog\s+expire\b|\bgc\b[^\n]*--prune\b|\bstash\s+(?:drop|clear)\b/i,
    new RegExp(
      String.raw`\brebas\w*\b[^\n]{0,60}?\b(?:onto|on|against)\s+(?:the\s+)?(?:latest\s+)?${SHARED}`,
      'i'
    ),
    /\bamend\w*\b[^\n]{0,60}\bpushed\b|\bpushed\b[^\n]{0,60}\bamend\w*/i,
    /\brewrit\w*\s+(?:the\s+)?(?:git\s+|commit\s+)?history\b/i,
    /\bgit\s+rebase\b/i
  ],
  send: [
    /\b(?:send|post|write|draft)\w*\s+(?:an?\s+|the\s+)?(?:e-?mail|message|dm|reply|notification|sms|text)\b/i,
    /\b(?:e-?mail|message|dm|text|ping|notify|slack|sms)\s+(?:the\s+)?(?:team|users?|customers?|clients?|people|him|her|them|someone|everyone|reviewers?|channel|sal|uma)\b/i,
    /\b(?:reply to|notify\w*|slack|sms|tweet\w*|twitter|usb)\b/i,
    /\bpost\w*\s+(?:it\s+|this\s+|that\s+)?(?:publicly|to (?:the )?(?:public|slack|twitter|x|social media))\b|\bpost it\b/i,
    /\bcomment\w*\s+on\s+(?:the\s+|this\s+|that\s+)?(?:pr|pull request|issue|mr)\b/i,
    /\bupload\w*|\bexfiltrat\w*/i,
    /\b(?:scp|rsync)\b[^\n]*\s[\w.@-]+:/i,
    // "email/message/text/dm/ping <anyone>": a name, a handle, an address, a pronoun or people.
    /\b(?:[Ee]-?mail|[Mm]essage|[Tt]ext|DM|[Dd]m|[Pp]ing)\s+(?:[A-Z][\w.-]*|@\w+|[\w.+-]+@[\w.-]+|him|her|them|someone|everyone|(?:the|our|my|your)\s+(?:team|users?|customers?|clients?|people|reviewers?|owners?|manager|channel|group|maintainers?|authors?|admins?|on-?call|lead))\b/,
    /\bgh\s+(?:pr|issue)\s+comment\b|\bgh\s+pr\s+review\b[^\n]*--comment\b|\bgit\s+send-email\b/i,
    /\b(?:post|send|push|curl)\w*\b[^\n]{0,60}?\b(?:webhooks?|chat|discord|teams channel|mattermost|telegram|whatsapp)\b|\bwebhooks?\b/i
  ],
  payment: [
    /\b(?:payments?|pay(?:s|ing)? (?:for|the)|purchas\w*|buy(?:s|ing)?|bought|order(?:s|ed|ing)? (?:a|an|the|more|new)|refund\w*|charg(?:e|es|ed|ing)\s+(?:the\s+)?(?:card|customer|user|client|account|them|him|her)|invoic\w*|billing|subscriptions?|stripe)\b/i
  ],
  credentials: [
    /\b(?:credentials?|passwords?|passwd|secrets?|tokens?|api[- ]?keys?|private[- ]keys?|ssh[- ]keys?|authorized_keys|keychain|certificates?|sudo|admin\w*|root (?:access|user|account|password|shell)|as root|permissions?|privileges?|chmod|chown|iam)\b/i,
    // Reading the environment or an env file exposes every secret in it.
    /\b(?:read|print|show|cat|dump|display|output|echo|view|open|inspect|log|copy|type|less|more|head|tail|source)\w*\b[^\n]{0,40}?(?:^|\s|\/)\.env[\w.-]*/i,
    /\bprintenv\b|\bexport\s+-p\b|(?:^|[\s;&|(])env\s*(?:$|[|>;&)])|(?:^|[\s;&|(])set\s*(?:$|[|>;&)])|\b(?:inspect|print|show|dump|list|display|log|echo)\w*\s+(?:all\s+)?(?:of\s+)?(?:the\s+)?(?:environment|env(?:ironment)? var(?:iable)?s)\b/i,
    /\.netrc\b|\.npmrc\b|\bworld[- ]writable\b|\bwritable by (?:everyone|all)\b|\brotat\w*\s+(?:the\s+)?(?:\w+\s+)?(?:keys?|secrets?|tokens?|credentials?)\b/i
  ]
}

/** Markdown code marks and quotes hide nothing from the patterns; whitespace runs are one space. */
function normalized(text: string): string {
  return text
    .replace(/[`'"‘’“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The first hard stop in title + prompt + why (the most specific category first), or null when
 * Keep going may run the step. An ad pause stops it only when the person asked to approve pauses.
 */
function findHardStop(
  plain: string,
  adPauses: NextStepAdPauses,
  deployText = plain,
  deleteDataText = plain
): HardStop | null {
  for (const [category, patterns] of Object.entries(HARD_STOPS) as [
    HardStopCategory,
    readonly RegExp[]
  ][]) {
    if (category === 'ad-pause' && adPauses === 'allowed') {
      continue
    }
    const text =
      category === 'deploy' ? deployText : category === 'delete-data' ? deleteDataText : plain
    if (patterns.some((pattern) => pattern.test(text))) {
      return { reason: `needs-you-${category}`, category }
    }
  }
  return null
}

export function hardStopOf(text: string, adPauses: NextStepAdPauses = 'allowed'): HardStop | null {
  return findHardStop(normalized(text), adPauses)
}

/** Questions can cite reports; a literal artifact name is not a deployment instruction. */
export function hardStopOfQuestion(
  text: string,
  adPauses: NextStepAdPauses = 'allowed'
): HardStop | null {
  const references = questionReferenceProjections(text)
  return findHardStop(
    normalized(text),
    adPauses,
    normalized(questionWithoutEvidenceCitations(references.deploy)),
    normalized(references.deleteData)
  )
}

/** True when the text pauses ads (and changes no spend): what an allowed pause records. */
export function pausesAds(text: string): boolean {
  return hardStopOf(text, 'ask-first')?.category === 'ad-pause'
}

/**
 * Only the first suggestion may run. Besides a hard stop, a question for the person and an empty
 * prompt stop Keep going; the risk label and kind otherwise do not.
 */
export function firstStepRefusal(
  set: NextStepSuggestionSet,
  adPauses: NextStepAdPauses = 'allowed'
): { reason: NextStepKeepGoingStopReason; detail?: string } | null {
  const first = set.suggestions[0]
  if (!first || !first.prompt.trim()) {
    return { reason: 'no-safe-suggestion', detail: 'There was no next step to run.' }
  }
  if (first.kind === 'ask') {
    return { reason: 'needs-you-question' }
  }
  const stop = hardStopOf(`${first.title}\n${first.prompt}\n${first.why ?? ''}`, adPauses)
  return stop ? { reason: stop.reason } : null
}
