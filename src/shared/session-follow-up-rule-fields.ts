import {
  exactHandoffFile,
  HANDOFF_FILE_MAX_BYTES,
  HANDOFF_THREAD_FILE_MAX_BYTES,
  type ExactHandoffFile
} from './console-handoff-contract'

/** The parts of a saved follow-up that describe files: deliverables, pins, capture and exceptions. */
export const SESSION_FOLLOW_UP_MAX_FILES = 32
export const SESSION_FOLLOW_UP_MAX_NAME_CHARS = 200
export const SESSION_FOLLOW_UP_MAX_FILE_BYTES = HANDOFF_FILE_MAX_BYTES
export const SESSION_FOLLOW_UP_SUMMARY_MAX_CHARS = 20_000

export type SessionFollowUpDeliverables =
  /** Absolute paths on the execution host, inside the workspace. */
  | { kind: 'files'; paths: string[] }
  /** A run's declared manifest; the files it lists are the deliverables. */
  | { kind: 'manifest'; manifestPath: string }
  /** Several runs' manifests (a fan-out); the union of the files they list. */
  | { kind: 'manifests'; manifestPaths: string[] }

export const SESSION_FOLLOW_UP_MAX_MANIFESTS = 8

export type SessionFollowUpFilePin = {
  /** Path on the execution host; null for a generated summary or transcript. */
  sourcePath: string | null
  generatedKind?: 'transcript'
  name: string
  sha256: string
  size: number
  /** Task file path the upload returned. */
  taskPath?: string
}

export const SESSION_FOLLOW_UP_EXCEPTION_CODES = [
  'run-failed',
  'host-unreachable',
  'unverifiable',
  'unreadable',
  'outside-workspace',
  'files-changed',
  'file-too-large',
  'too-many-files',
  'duplicate-names',
  'summary-unavailable',
  'upload-failed',
  'rejected',
  'unconfirmed',
  'save-failed'
] as const
export type SessionFollowUpExceptionCode = (typeof SESSION_FOLLOW_UP_EXCEPTION_CODES)[number]

export type SessionFollowUpException = {
  code: SessionFollowUpExceptionCode
  /** What the exception is about: a file name, people, or a host. */
  subject: string
  /** The underlying message, kept for the person to read. */
  detail: string
  at: number
  /** Automatic resends this failure has already cost; absent means none. */
  retries?: number
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined
}

export function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined
}

export function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function oneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return options.includes(value as T) ? (value as T) : undefined
}

const DIGEST = /^[a-f0-9]{64}$/

export function normalizeDeliverables(value: unknown): SessionFollowUpDeliverables | null {
  const raw = record(value)
  if (raw?.kind === 'manifest') {
    const manifestPath = text(raw.manifestPath, 4096)
    return manifestPath ? { kind: 'manifest', manifestPath } : null
  }
  if (raw?.kind === 'manifests' && Array.isArray(raw.manifestPaths)) {
    const manifestPaths = [
      ...new Set(
        raw.manifestPaths.map((path) => text(path, 4096)).filter((path): path is string => !!path)
      )
    ]
    return manifestPaths.length > 0 && manifestPaths.length <= SESSION_FOLLOW_UP_MAX_MANIFESTS
      ? { kind: 'manifests', manifestPaths }
      : null
  }
  if (raw?.kind === 'files' && Array.isArray(raw.paths)) {
    const paths = [
      ...new Set(raw.paths.map((path) => text(path, 4096)).filter((path): path is string => !!path))
    ]
    return paths.length <= SESSION_FOLLOW_UP_MAX_FILES ? { kind: 'files', paths } : null
  }
  return null
}

function normalizePin(value: unknown): SessionFollowUpFilePin | null {
  const raw = record(value)
  const name = text(raw?.name, 255)
  const sha256 = matching(raw?.sha256, DIGEST)
  const size = finite(raw?.size)
  const sourcePath = raw?.sourcePath === null ? null : text(raw?.sourcePath, 4096)
  if (
    !raw ||
    !name ||
    /[\\/]/.test(name) ||
    !sha256 ||
    size === undefined ||
    !Number.isInteger(size) ||
    size < 0 ||
    size > HANDOFF_THREAD_FILE_MAX_BYTES ||
    sourcePath === undefined
  ) {
    return null
  }
  const taskPath = text(raw.taskPath, 4096)
  return {
    sourcePath,
    name,
    sha256,
    size,
    ...(raw.generatedKind === 'transcript' ? { generatedKind: 'transcript' as const } : {}),
    ...(taskPath ? { taskPath } : {})
  }
}

export function normalizeException(value: unknown): SessionFollowUpException | undefined {
  const raw = record(value)
  const code = oneOf(raw?.code, SESSION_FOLLOW_UP_EXCEPTION_CODES)
  if (!raw || !code) {
    return undefined
  }
  const retries = finite(raw.retries)
  return {
    code,
    subject: typeof raw.subject === 'string' ? raw.subject.slice(0, 500) : '',
    detail: typeof raw.detail === 'string' ? raw.detail.slice(0, 2000) : '',
    at: finite(raw.at) ?? 0,
    // A count the record cannot trust is dropped, never guessed: the bound then starts over.
    ...(retries !== undefined && Number.isInteger(retries) && retries > 0 && retries <= 1_000
      ? { retries }
      : {})
  }
}

export type SessionFollowUpRequestText = { title: string; description: string }

function normalizeRequestText(raw: unknown): SessionFollowUpRequestText | undefined {
  const value = raw as { title?: unknown; description?: unknown } | null
  return typeof value?.title === 'string' &&
    typeof value.description === 'string' &&
    value.title.trim() &&
    value.title.length <= 160 &&
    value.description.trim() &&
    value.description.length <= 8192
    ? { title: value.title, description: value.description }
    : undefined
}

export function normalizeCapture(raw: Record<string, unknown>): {
  capturedAt?: number
  files?: SessionFollowUpFilePin[]
  summaryMarkdown?: string
  transcriptFile?: ExactHandoffFile
  request?: SessionFollowUpRequestText
  summaryFile?: string
} {
  const capturedAt = finite(raw.capturedAt)
  const summaryFile = text(raw.summaryFile, 255)
  if (raw.reask === true && capturedAt === undefined && summaryFile && !/[\\/]/.test(summaryFile)) {
    return { summaryFile }
  }
  const pins = Array.isArray(raw.files) ? raw.files.map(normalizePin) : []
  const summary =
    typeof raw.summaryMarkdown === 'string' &&
    raw.summaryMarkdown.length <= SESSION_FOLLOW_UP_SUMMARY_MAX_CHARS
      ? raw.summaryMarkdown
      : undefined
  const complete = pins.every((pin): pin is SessionFollowUpFilePin => !!pin)
  const transcript = exactHandoffFile.safeParse(raw.transcriptFile)
  // Why: a capture that cannot be delivered exactly as captured starts over at the next completion.
  if (
    capturedAt === undefined ||
    !complete ||
    pins.length > SESSION_FOLLOW_UP_MAX_FILES ||
    new Set(pins.map((pin) => pin.name)).size !== pins.length ||
    (pins.some((pin) => pin.sourcePath === null && pin.generatedKind !== 'transcript') &&
      summary === undefined) ||
    pins.some(
      (pin) =>
        pin.generatedKind === 'transcript' &&
        (!transcript.success ||
          transcript.data.name !== pin.name ||
          transcript.data.sha256 !== pin.sha256 ||
          transcript.data.size !== pin.size)
    )
  ) {
    return {}
  }
  return {
    capturedAt,
    files: pins,
    ...(summary !== undefined ? { summaryMarkdown: summary } : {}),
    ...(transcript.success ? { transcriptFile: transcript.data } : {}),
    ...(normalizeRequestText(raw.request) ? { request: normalizeRequestText(raw.request) } : {}),
    ...(text(raw.summaryFile, 255) && pins.some((pin) => pin?.name === raw.summaryFile)
      ? { summaryFile: text(raw.summaryFile, 255) }
      : {})
  }
}
