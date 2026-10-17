import {
  ARTIFACT_AUDIENCES,
  ARTIFACT_REVIEW_CATEGORY_MAX_CHARS,
  ARTIFACT_REVIEW_OPTION_DETAIL_MAX_CHARS,
  ARTIFACT_REVIEW_OPTION_LABEL_MAX_CHARS,
  ARTIFACT_REVIEW_OPTIONS_MAX,
  ARTIFACT_REVIEW_OPTIONS_MIN,
  ARTIFACT_REVIEW_QUESTION_MAX_CHARS,
  ARTIFACT_REVIEW_SUMMARY_MAX_CHARS,
  ARTIFACT_REVIEWERS_MAX,
  type ArtifactAudience,
  type ArtifactReviewFields,
  type ArtifactReviewOption,
  type ArtifactReviewRequest
} from '../shared/artifact-review'
import { REPEATED_FLAG_SEPARATOR } from './args'
import { RuntimeClientError } from './runtime-client'
import { artifactProposalSchema } from '../shared/artifact-proposal'

type CliFlags = ReadonlyMap<string, string | boolean>

const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/
const EMPLOYEE_ID_PATTERN = /^emp_[A-Za-z0-9_-]+$/

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

function textFlag(flags: CliFlags, name: string): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`--${name} requires a value.`)
  }
  return value.trim()
}

function parseQuestion(flags: CliFlags): string | undefined {
  const question = textFlag(flags, 'question')
  if (question !== undefined && question.length > ARTIFACT_REVIEW_QUESTION_MAX_CHARS) {
    throw invalid(`--question must be at most ${ARTIFACT_REVIEW_QUESTION_MAX_CHARS} characters.`)
  }
  return question
}

function parseCategory(flags: CliFlags): string | undefined {
  const category = textFlag(flags, 'category')
  if (category !== undefined && category.length > ARTIFACT_REVIEW_CATEGORY_MAX_CHARS) {
    throw invalid(`--category must be at most ${ARTIFACT_REVIEW_CATEGORY_MAX_CHARS} characters.`)
  }
  return category
}

function parseReviewers(flags: CliFlags): string[] | undefined {
  const raw = textFlag(flags, 'reviewers')
  if (raw === undefined) {
    return undefined
  }
  const reviewers = [
    ...new Set(
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  ]
  if (reviewers.length === 0) {
    throw invalid('--reviewers requires at least one email or emp_ id.')
  }
  if (reviewers.length > ARTIFACT_REVIEWERS_MAX) {
    throw invalid(`--reviewers accepts at most ${ARTIFACT_REVIEWERS_MAX} people.`)
  }
  const unrecognized = reviewers.filter(
    (entry) => !EMAIL_PATTERN.test(entry) && !EMPLOYEE_ID_PATTERN.test(entry)
  )
  if (unrecognized.length > 0) {
    throw invalid(
      `--reviewers entries must be emails or emp_ ids; not recognized: ${unrecognized.join(', ')}`
    )
  }
  return reviewers
}

function parseAudience(flags: CliFlags): ArtifactAudience | undefined {
  const audience = textFlag(flags, 'audience')
  if (audience === undefined) {
    return undefined
  }
  if (!(ARTIFACT_AUDIENCES as readonly string[]).includes(audience)) {
    throw invalid(`--audience must be one of: ${ARTIFACT_AUDIENCES.join(', ')}.`)
  }
  return audience as ArtifactAudience
}

function switchFlag(flags: CliFlags, name: string, hint = ''): boolean {
  const value = flags.get(name)
  if (value === undefined || value === true) {
    return value === true
  }
  if (value === 'true' || value === 'false') {
    return value === 'true'
  }
  throw invalid(`--${name} does not take a value${hint}.`)
}

function parseSummary(flags: CliFlags): string | undefined {
  const summary = textFlag(flags, 'summary')
  if (summary !== undefined && summary.length > ARTIFACT_REVIEW_SUMMARY_MAX_CHARS) {
    throw invalid(`--summary must be at most ${ARTIFACT_REVIEW_SUMMARY_MAX_CHARS} characters.`)
  }
  return summary
}

// Why: the server collapses whitespace in a label, so matching here must too.
function optionLabel(text: string): string {
  return text.trim().split(/\s+/).join(' ')
}

function repeatedTextFlag(flags: CliFlags, name: string, shape: string): string[] | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value !== 'string') {
    throw invalid(`--${name} requires a value: ${shape}.`)
  }
  return value.split(REPEATED_FLAG_SEPARATOR)
}

function parseOptions(flags: CliFlags): ArtifactReviewOption[] | undefined {
  const entries = repeatedTextFlag(flags, 'option', '"<label>[::detail]"')
  if (entries === undefined) {
    return undefined
  }
  if (
    entries.length < ARTIFACT_REVIEW_OPTIONS_MIN ||
    entries.length > ARTIFACT_REVIEW_OPTIONS_MAX
  ) {
    throw invalid(
      `Pass --option ${ARTIFACT_REVIEW_OPTIONS_MIN} to ${ARTIFACT_REVIEW_OPTIONS_MAX} times, once per answer.`
    )
  }
  const options: ArtifactReviewOption[] = []
  for (const entry of entries) {
    const split = entry.indexOf('::')
    const label = optionLabel(split === -1 ? entry : entry.slice(0, split))
    const detail = split === -1 ? '' : entry.slice(split + 2).trim()
    if (!label || label.length > ARTIFACT_REVIEW_OPTION_LABEL_MAX_CHARS) {
      throw invalid(
        `Each --option needs a label of at most ${ARTIFACT_REVIEW_OPTION_LABEL_MAX_CHARS} characters.`
      )
    }
    if (detail.length > ARTIFACT_REVIEW_OPTION_DETAIL_MAX_CHARS) {
      throw invalid(
        `An --option detail is at most ${ARTIFACT_REVIEW_OPTION_DETAIL_MAX_CHARS} characters.`
      )
    }
    if (options.some((option) => option.label.toLowerCase() === label.toLowerCase())) {
      throw invalid(`--option labels must differ: '${label}' appears twice.`)
    }
    options.push({ label, ...(detail ? { detail } : {}) })
  }
  return options
}

function markRecommended(
  flags: CliFlags,
  options: ArtifactReviewOption[] | undefined,
  multi: boolean
): ArtifactReviewOption[] | undefined {
  const entries = repeatedTextFlag(flags, 'recommend', '<label>')
  if (entries === undefined) {
    return options
  }
  if (options === undefined) {
    throw invalid('--recommend needs --option.')
  }
  const labels = entries.map(optionLabel)
  const unknown = labels.filter(
    (label) => !options.some((option) => option.label.toLowerCase() === label.toLowerCase())
  )
  if (unknown.length > 0) {
    throw invalid(`--recommend must name an --option label; not found: ${unknown.join(', ')}`)
  }
  const picked = new Set(labels.map((label) => label.toLowerCase()))
  if (picked.size > 1 && !multi) {
    throw invalid('--recommend names at most one answer unless --multi allows several.')
  }
  return options.map((option) =>
    picked.has(option.label.toLowerCase()) ? { ...option, recommended: true } : option
  )
}

/**
 * Only flags the user passed become keys, so a share without review flags produces the
 * same request body as before review support existed.
 */
export function parseArtifactReviewFlags(flags: CliFlags): ArtifactReviewFields {
  const question = parseQuestion(flags)
  const reviewers = parseReviewers(flags)
  const category = parseCategory(flags)
  const audience = parseAudience(flags)
  const summary = parseSummary(flags)
  if (flags.has('option') && flags.has('proposal-json')) {
    // Why: the server refuses both; an option is approved with its pick, a proposal as published.
    throw invalid('--option cannot be combined with --proposal-json.')
  }
  const multi = switchFlag(flags, 'multi')
  const options = markRecommended(flags, parseOptions(flags), multi)
  if (multi && options === undefined) {
    throw invalid('--multi needs --option.')
  }
  const proposal = textFlag(flags, 'proposal-json')
  let context: ArtifactReviewRequest['context']
  if (proposal !== undefined) {
    try {
      if (proposal.length > 24_000) {
        throw new Error('too large')
      }
      context = artifactProposalSchema.parse(JSON.parse(proposal))
    } catch {
      throw invalid(
        '--proposal-json must be a bounded version-1 proposal context; see the artifact guide.'
      )
    }
  }
  const review: ArtifactReviewRequest | undefined =
    switchFlag(flags, 'review', '; use --question to ask something specific') ||
    question !== undefined ||
    reviewers !== undefined ||
    category !== undefined ||
    context !== undefined ||
    summary !== undefined ||
    options !== undefined
      ? {
          ...(question !== undefined ? { question } : {}),
          ...(reviewers !== undefined ? { reviewers } : {}),
          ...(category !== undefined ? { about: { category } } : {}),
          ...(context !== undefined ? { context } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(options !== undefined ? { options } : {}),
          ...(multi ? { multi: true as const } : {})
        }
      : undefined
  return {
    ...(review ? { review } : {}),
    ...(audience ? { audience } : {})
  }
}
