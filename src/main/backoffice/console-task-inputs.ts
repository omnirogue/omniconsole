import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  exactHandoffFile,
  handoffFile,
  handoffId,
  handoffDigest,
  HANDOFF_FILE_MAX_BYTES
} from '../../shared/console-handoff-contract'
import { taskId } from '../../shared/console-workflow-schemas'
import { consoleConversationSourcePath } from '../../shared/console-conversation-source-files'
import { authorizeParentTaskInputs } from './console-parent-task-inputs'
import type { ConsoleLocalJob } from '../console-workflows/console-local-execution-contract'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { downloadHandoffFile } from './console-handoff-files'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { downloadVerifiedConsoleFile } from './console-file-download'

const fileInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('handoff_file'),
      thread_id: handoffId,
      file: handoffFile.extend({
        name: exactHandoffFile.shape.name,
        size: exactHandoffFile.shape.size
      })
    })
    .strict(),
  z
    .object({
      kind: z.literal('task_file'),
      task_id: taskId,
      target_path: consoleConversationSourcePath.optional(),
      executable: z.boolean().optional(),
      file: z
        .object({
          rel: z
            .string()
            .min(1)
            .max(4096)
            .refine(
              (value) =>
                !value.startsWith('/') &&
                !/[\\\0]/.test(value) &&
                !value.split('/').some((part) => !part || part === '..' || part === '.')
            ),
          sha256: handoffDigest,
          size_bytes: z.number().int().min(0).max(HANDOFF_FILE_MAX_BYTES),
          name: exactHandoffFile.shape.name.optional()
        })
        .strict()
    })
    .strict()
])

async function privateDirectory(parent: string, name: string): Promise<string> {
  const directory = join(parent, name)
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') {
      throw error
    }
  })
  const stat = await lstat(directory)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(directory)) !== directory ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error('The task input directory is not a private local directory.')
  }
  return directory
}

/** Frozen handoff versions become readable files without adding inputs to the job's Git diff. */
export async function prepareConsoleTaskInputs(job: ConsoleLocalJob): Promise<string[]> {
  const inputs = job.inputs
    .filter(
      (input) =>
        input &&
        typeof input === 'object' &&
        'kind' in input &&
        ['handoff_file', 'task_file'].includes(String(input.kind))
    )
    .map((input) => fileInput.parse(input))
  if (!inputs.length) {
    return []
  }
  if (inputs.length > 32 || !/^job_[a-z0-9]{8,40}$/.test(job.id)) {
    throw new Error('The admitted task has too many input files or an invalid job identity.')
  }
  const person = await captureConsoleWorkflowPerson()
  if (!person.ok) {
    throw new Error(person.error.message)
  }
  const verifyParentInputs = await authorizeParentTaskInputs(
    job,
    inputs.flatMap((input) => (input.kind === 'task_file' ? [input.task_id] : [])),
    person.data
  )
  const root = await realpath(getProfileUserDataPath())
  const directory = await privateDirectory(
    await privateDirectory(
      await privateDirectory(root, 'console-task-inputs'),
      person.data.principal
    ),
    job.id
  )
  const paths: string[] = []
  for (const input of inputs) {
    if (!person.data.isCurrent()) {
      throw new Error('The signed-in person changed before reading task inputs.')
    }
    const downloaded =
      input.kind === 'handoff_file'
        ? await downloadHandoffFile(
            { threadId: input.thread_id, file: input.file },
            person.data.principal
          )
        : await downloadVerifiedConsoleFile(
            `/api/gtd/hub/api/board/${input.task_id}/files/download?${new URLSearchParams({ path: input.file.rel })}`,
            {
              name: input.file.name ?? input.file.rel.split('/').at(-1)!,
              available: true,
              size: input.file.size_bytes,
              sha256: input.file.sha256
            },
            person.data.principal
          )
    if (!downloaded.ok) {
      throw new Error(downloaded.error.message)
    }
    if (!person.data.isCurrent()) {
      throw new Error('The signed-in person changed while reading task inputs.')
    }
    const file = downloaded.data
    if (!file.name || /[\\/\0]/.test(file.name)) {
      throw new Error('The task input has an invalid file name.')
    }
    const identity =
      input.kind === 'handoff_file'
        ? createHash('sha256').update(input.file.id).digest('hex')
        : input.file.sha256
    const path = join(directory, `${identity}-${Array.from(file.name).slice(0, 40).join('')}`)
    const bytes = Buffer.from(file.contentBase64, 'base64')
    await writeFile(path, bytes, { flag: 'wx', mode: 0o400 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') {
          throw error
        }
      }
    )
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) {
      throw new Error('The retained task input no longer matches its admitted file version.')
    }
    const saved = await readFile(path)
    if (createHash('sha256').update(saved).digest('hex') !== input.file.sha256) {
      throw new Error('The retained task input no longer matches its admitted file version.')
    }
    paths.push(path)
  }
  await verifyParentInputs()
  return paths
}
