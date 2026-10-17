import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureJsonFile } from '../../shared/secure-file'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import { requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import { RoomError } from './room-error'

const origin = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/'
      )
    } catch {
      return false
    }
  })
  .transform((value) => new URL(value).origin)
export const roomOrigins = z.object({ apiOrigin: origin, frontendOrigin: origin }).strict()
const discovery = z.object({
  mode: z.string(),
  ready: z.boolean(),
  apiOrigin: origin.nullish(),
  frontendOrigin: origin.nullish(),
  nativeRooms: z
    .object({
      ready: z.boolean(),
      apiOrigin: origin.nullish(),
      frontendOrigin: origin.nullish()
    })
    .optional()
})
export type RoomConfiguration = z.infer<typeof roomOrigins> & {
  mode: string
  key: string
  isCurrent(): boolean
}
let cached: { key: string; until: number; value: z.infer<typeof discovery> } | undefined

async function context() {
  const result = await captureConsoleWorkflowPerson()
  if (!result.ok) {
    throw new RoomError('console_unavailable')
  }
  const person = result.data
  const key = createHash('sha256')
    .update(`${person.profileKey}:${person.principal}:${person.baseUrl}`)
    .digest('hex')
  return { key, person, file: join(getProfileUserDataPath(), 'rooms', `${key}-origins.json`) }
}
export async function configureRoomOrigins(raw: unknown): Promise<null> {
  const value = roomOrigins.parse(raw),
    captured = await context()
  if (!captured.person.isCurrent()) {
    throw new RoomError('connection_changed')
  }
  writeSecureJsonFile(captured.file, value)
  cached = undefined
  return null
}
export async function getRoomConfig(): Promise<RoomConfiguration> {
  const captured = await context()
  let value: z.infer<typeof discovery>
  if (cached?.key === captured.key && cached.until > Date.now()) {
    value = cached.value
  } else {
    const result = await requestConsoleWorkflow('/api/communication/config', 'GET', discovery)
    if (!result.ok) {
      throw new RoomError('console_unavailable')
    }
    value = result.data
    cached = { key: captured.key, value, until: Date.now() + 30000 }
  }
  if (!captured.person.isCurrent()) {
    throw new RoomError('connection_changed')
  }
  const native = value.nativeRooms
  if (
    native
      ? !native.ready || !['legacy', 'omniconsole'].includes(value.mode)
      : !value.ready || value.mode !== 'omniconsole'
  ) {
    throw new RoomError('not_ready')
  }
  const supplied = native ?? value
  let fallback: z.infer<typeof roomOrigins> | undefined
  if (!native && (!supplied.apiOrigin || !supplied.frontendOrigin) && existsSync(captured.file)) {
    try {
      fallback = roomOrigins.parse(JSON.parse(readFileSync(captured.file, 'utf8')))
    } catch {
      throw new RoomError('config_missing')
    }
  }
  const parsed = roomOrigins.safeParse({
    apiOrigin: supplied.apiOrigin ?? fallback?.apiOrigin,
    frontendOrigin: supplied.frontendOrigin ?? fallback?.frontendOrigin
  })
  if (!parsed.success) {
    throw new RoomError('config_missing')
  }
  const key = createHash('sha256')
    .update(JSON.stringify([captured.key, parsed.data]))
    .digest('hex')
  return { ...parsed.data, mode: value.mode, key, isCurrent: captured.person.isCurrent }
}
