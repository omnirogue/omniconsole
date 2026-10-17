import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { constants } from 'node:fs'
import { JEV_CONTROL_METHODS, jevRequestSchema } from '../../shared/jev-control'
import { JEV_TRIAL_RECIPES } from '../../shared/jev-trial-workflow'
import { JEV_REQUEST_V2_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { requireJevRuntimeCapability } from './jev-capability'

const status: CommandHandler = async (ctx) => {
  const response = await ctx.client.call(JEV_CONTROL_METHODS.status, {})
  console.log(JSON.stringify(response.result, null, 2))
}

const configure =
  (enabled: boolean): CommandHandler =>
  async (ctx) => {
    const response = await ctx.client.call(JEV_CONTROL_METHODS.configure, { enabled })
    console.log(JSON.stringify(response.result, null, 2))
  }

export async function readJevJsonFile(file: string, maxBytes = 24_000): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error(`Input must be a regular JSON file under ${maxBytes} bytes.`)
    }
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxBytes || bytesRead < stat.size) {
      throw new Error('Input exceeded its limit or changed while reading.')
    }
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await handle.close()
  }
}

const request: CommandHandler = async (ctx) => {
  if (process.env.ORCA_CLI_CWD) {
    throw new RuntimeClientError(
      'invalid_argument',
      'JEV file input is unavailable through a forwarded SSH/WSL shell. Run the CLI where the file lives and select the paired runtime with --environment.'
    )
  }
  const file = ctx.flags.get('file')
  if (typeof file !== 'string' || !file.trim()) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--file needs a JSON file containing recipeId and state.'
    )
  }
  const control = ctx.flags.get('jev') ?? 'request'
  let input: unknown
  try {
    input = await readJevJsonFile(resolve(ctx.cwd, file))
  } catch {
    throw new RuntimeClientError(
      'invalid_argument',
      'Cannot read a bounded JSON request from --file.'
    )
  }
  const parsed = jevRequestSchema.safeParse({ input, control })
  if (!parsed.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      parsed.error.issues[0]?.message ?? 'Invalid JEV request.'
    )
  }
  const { recipeId } = parsed.data.input
  if (!(JEV_TRIAL_RECIPES as readonly string[]).includes(recipeId)) {
    await requireJevRuntimeCapability(
      ctx,
      JEV_REQUEST_V2_RUNTIME_CAPABILITY,
      `the ${recipeId} JEV recipe`
    )
  }
  const response = await ctx.client.call(JEV_CONTROL_METHODS.request, parsed.data)
  console.log(JSON.stringify(response.result, null, 2))
}

export const JEV_HANDLERS: Record<string, CommandHandler> = {
  'jev status': status,
  'jev on': configure(true),
  'jev off': configure(false),
  'jev request': request
}
