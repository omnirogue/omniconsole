import { resolve } from 'node:path'
import {
  JEV_RUBRICS_RUNTIME_CAPABILITY,
  JEV_RUBRIC_METHODS,
  JEV_RUBRIC_MAX_INPUT_BYTES,
  jevRubricEvaluationSchema,
  jevRubricSaveSchema
} from '../../shared/jev-rubrics'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { readJevJsonFile } from './jev'
import { requireJevRuntimeCapability } from './jev-capability'

const MAX_INPUT_BYTES = JEV_RUBRIC_MAX_INPUT_BYTES

const requireRubricCapability = (ctx: HandlerContext): Promise<void> =>
  requireJevRuntimeCapability(ctx, JEV_RUBRICS_RUNTIME_CAPABILITY, 'JEV rubric tools')

export async function readJevRubricStdin(
  stream: AsyncIterable<Buffer | string> = process.stdin
): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_INPUT_BYTES) {
      throw new Error('Input exceeded 48 KB.')
    }
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Exactly one of --file or --input-stdin; forwarded SSH/WSL shells must pipe stdin. */
export async function readJevJsonInput(ctx: HandlerContext): Promise<unknown> {
  const file = ctx.flags.get('file')
  const stdin = ctx.flags.get('input-stdin')
  if (
    (stdin !== undefined && stdin !== true) ||
    (file !== undefined && (typeof file !== 'string' || !file.trim())) ||
    (stdin === true) === (typeof file === 'string')
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass exactly one of --file <JSON file> or --input-stdin.'
    )
  }
  if (typeof file === 'string' && process.env.ORCA_CLI_CWD) {
    throw new RuntimeClientError(
      'invalid_argument',
      'File input is unavailable through a forwarded SSH/WSL shell. Pipe the host file to --input-stdin instead.'
    )
  }
  try {
    return stdin === true
      ? await readJevRubricStdin()
      : await readJevJsonFile(resolve(ctx.cwd, file as string), MAX_INPUT_BYTES)
  } catch {
    throw new RuntimeClientError(
      'invalid_argument',
      'Cannot read valid bounded JSON input (maximum 48 KB).'
    )
  }
}

const list: CommandHandler = async (ctx) => {
  await requireRubricCapability(ctx)
  const response = await ctx.client.call(JEV_RUBRIC_METHODS.list, {})
  console.log(JSON.stringify(response.result, null, 2))
}

const save: CommandHandler = async (ctx) => {
  const replace = ctx.flags.get('replace') ?? false
  if (typeof replace !== 'boolean') {
    throw new RuntimeClientError('invalid_argument', '--replace is a boolean flag.')
  }
  await requireRubricCapability(ctx)
  const parsed = jevRubricSaveSchema.safeParse({ rubric: await readJevJsonInput(ctx), replace })
  if (!parsed.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      parsed.error.issues[0]?.message ?? 'Invalid rubric.'
    )
  }
  const response = await ctx.client.call(JEV_RUBRIC_METHODS.save, parsed.data)
  console.log(JSON.stringify(response.result, null, 2))
}

const evaluate: CommandHandler = async (ctx) => {
  await requireRubricCapability(ctx)
  const parsed = jevRubricEvaluationSchema.safeParse({
    input: await readJevJsonInput(ctx),
    control: ctx.flags.get('jev') ?? 'request'
  })
  if (!parsed.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      parsed.error.issues[0]?.message ?? 'Invalid evaluation.'
    )
  }
  const response = await ctx.client.call(JEV_RUBRIC_METHODS.evaluate, parsed.data)
  console.log(JSON.stringify(response.result, null, 2))
}

export const JEV_RUBRIC_HANDLERS: Record<string, CommandHandler> = {
  'jev rubrics list': list,
  'jev rubrics save': save,
  'jev rubrics evaluate': evaluate
}
