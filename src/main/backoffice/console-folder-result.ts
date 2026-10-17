import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { visit } from 'jsonc-parser'
import { z } from 'zod'
import {
  consoleJobArtifactReceipt,
  type ConsoleJobArtifactReceipt,
  type ConsoleJobFolderResult
} from '../../shared/console-job-results'
import { jobId } from '../../shared/console-workflow-schemas'
import { containsSourceControlCharacter } from '../../shared/console-conversation-source-files'

const MAX_REPORT_BYTES = 48 * 1024 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_FILE_BYTES = 32 * 1024 * 1024
const MAX_FILES = 4096
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const validUnicode = (value: string): boolean => Buffer.from(value).toString('utf8') === value

const relativePath = z
  .string()
  .refine(
    (value) =>
      value.length > 0 &&
      [...value].length <= 1024 &&
      validUnicode(value) &&
      !value.startsWith('/') &&
      !/^[A-Za-z]:/.test(value) &&
      !value.includes('\\') &&
      !containsSourceControlCharacter(value) &&
      value.split('/').every((part) => !['', '.', '..', '.git'].includes(part.toLowerCase())),
    'Folder result files require safe relative paths.'
  )

const envelope = z
  .object({
    schema_version: z.literal(1),
    kind: z.enum(['folder_report', 'handoff_report']),
    job_id: jobId,
    attempt: z.number().int().positive(),
    response: z
      .string()
      .refine(
        (value) =>
          value.trim().length > 0 &&
          validUnicode(value) &&
          Buffer.byteLength(value, 'utf8') <= MAX_RESPONSE_BYTES,
        'Folder result requires the complete response within its 1 MiB limit.'
      ),
    changed_files: z.array(relativePath).max(MAX_FILES),
    files: z
      .array(
        z
          .object({
            path: relativePath,
            mode: z.number().int().min(0).max(0o777),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            size_bytes: z.number().int().min(0).max(MAX_FILE_BYTES),
            content_b64: z.string()
          })
          .strict()
      )
      .max(MAX_FILES)
  })
  .strict()

function parseUnambiguousJson(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const parsed: unknown = JSON.parse(text)
  const objectKeys: Set<string>[] = []
  visit(text, {
    onObjectBegin: () => {
      objectKeys.push(new Set())
    },
    onObjectProperty: (key) => {
      const keys = objectKeys.at(-1)!
      if (keys.has(key)) {
        throw new Error('Folder result JSON contains a duplicate key.')
      }
      keys.add(key)
    },
    onObjectEnd: () => {
      objectKeys.pop()
    },
    onLiteralValue: (value, offset, length) => {
      if (
        typeof value === 'number' &&
        (!Number.isSafeInteger(value) || /[.eE]/.test(text.slice(offset, offset + length)))
      ) {
        throw new Error('Folder result JSON numbers must be exact integers.')
      }
    }
  })
  return parsed
}

// Reports use Python's Unicode codepoint ordering, which differs from JS UTF-16 sorting.
function comparePaths(left: string, right: string): number {
  const leftPoints = [...left]
  const rightPoints = [...right]
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = leftPoints[index].codePointAt(0)! - rightPoints[index].codePointAt(0)!
    if (difference !== 0) {
      return difference
    }
  }
  return leftPoints.length - rightPoints.length
}

function assertSortedDistinct(paths: string[]): void {
  if (paths.some((path, index) => index > 0 && comparePaths(paths[index - 1], path) >= 0)) {
    throw new Error('Folder result paths must be sorted and distinct.')
  }
}

function validateFiles(files: ConsoleJobFolderResult['files']): void {
  const paths = files.map((file) => file.path)
  assertSortedDistinct(paths)
  const pathSet = new Set(paths)
  let totalBytes = 0
  for (const file of files) {
    const parts = file.path.split('/')
    if (parts.some((_, index) => index > 0 && pathSet.has(parts.slice(0, index).join('/')))) {
      throw new Error('Folder result file conflicts with another file’s parent directory.')
    }
    totalBytes += file.size_bytes
    if (totalBytes > MAX_TOTAL_FILE_BYTES) {
      throw new Error('Folder result files exceed their total 32 MiB limit.')
    }
    if (file.content_b64.length !== 4 * Math.ceil(file.size_bytes / 3)) {
      throw new Error('Folder result file bytes differ from their pinned size.')
    }
    const content = Buffer.from(file.content_b64, 'base64')
    if (
      content.length !== file.size_bytes ||
      content.toString('base64') !== file.content_b64 ||
      sha256(content) !== file.sha256
    ) {
      throw new Error('Folder result file bytes differ from their pinned digest and size.')
    }
  }
}

export function decodeConsoleFolderResult(
  bytes: Buffer,
  pin: ConsoleJobArtifactReceipt
): ConsoleJobFolderResult {
  const receipt = consoleJobArtifactReceipt.parse(pin)
  if (
    bytes.length === 0 ||
    bytes.length > MAX_REPORT_BYTES ||
    bytes.length !== receipt.size_bytes ||
    sha256(bytes) !== receipt.sha256
  ) {
    throw new Error('Folder result bytes differ from the saved artifact receipt.')
  }
  const report = envelope.parse(parseUnambiguousJson(bytes))
  if (report.job_id !== receipt.job_id || report.attempt !== receipt.attempt) {
    throw new Error('Folder result belongs to a different job attempt.')
  }
  assertSortedDistinct(report.changed_files)
  validateFiles(report.files)
  return {
    job_id: report.job_id,
    attempt: report.attempt,
    receipt,
    response: report.response,
    changed_files: report.changed_files,
    files: report.files
  }
}
