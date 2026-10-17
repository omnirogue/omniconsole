import { z } from 'zod'
import type { ConsoleLocalJob } from './console-local-execution-contract'
import { consoleCurrentGitSource } from './console-current-git-source'

export const consoleFolderSnapshotPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !Array.from(path).some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
      }) &&
      !path.split('/').some((part) => !part || ['.', '..', '.git'].includes(part.toLowerCase()))
  )

export function consoleFolderRoundInput(job: ConsoleLocalJob): Record<string, unknown> | null {
  return (
    job.inputs.find(
      (input): input is Record<string, unknown> =>
        !!input && typeof input === 'object' && !Array.isArray(input) && 'loop_stage' in input
    ) ?? null
  )
}

export function consoleFolderRoundSourceFiles(
  job: ConsoleLocalJob
): { target_path: string; file?: { sha256?: string | null } }[] {
  const current = consoleCurrentGitSource(job)
  if (current) {
    return current.paths.map((target_path) => ({
      target_path,
      file: {
        sha256:
          current.source.files.find((file) => file.target_path === target_path)?.file.sha256 ?? null
      }
    }))
  }
  const value = consoleFolderRoundInput(job)?.source_files
  if (!Array.isArray(value)) {
    throw new Error('The folder snapshot has no sealed selected files.')
  }
  const files = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('The folder snapshot selected file is malformed.')
    }
    const record = item as Record<string, unknown>
    return {
      target_path: consoleFolderSnapshotPath.parse(record.target_path),
      file: record.file as { sha256?: string } | undefined
    }
  })
  const paths = files.map((file) => file.target_path)
  if (
    !paths.length ||
    new Set(paths).size !== paths.length ||
    paths.join() !== [...paths].sort().join()
  ) {
    throw new Error('The folder snapshot selected paths are not sorted and distinct.')
  }
  return files
}
