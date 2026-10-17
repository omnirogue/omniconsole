import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

const ledgerSchema = z.array(z.object({ nonce: z.string().uuid(), expiresAt: z.number().int() }))

/** Called under the durable acceptance lock; a damaged ledger refuses rather than forgetting. */
export async function consumeConnectorNonce(
  directory: string,
  nonce: string,
  expiresAt: number,
  now: number
): Promise<void> {
  const file = join(directory, 'connector-nonces.json')
  let entries: z.infer<typeof ledgerSchema> = []
  try {
    entries = ledgerSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  entries = entries.filter((entry) => entry.expiresAt * 1000 > now)
  if (entries.some((entry) => entry.nonce === nonce)) {
    throw new Error('Connector session prep nonce was already consumed.')
  }
  entries.push({ nonce, expiresAt })
  await mkdir(directory, { recursive: true })
  await writeFileDurable(durableWriteTempPath(file), file, JSON.stringify(entries))
}
