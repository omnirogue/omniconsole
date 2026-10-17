import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { customerServiceLaunchId } from '../../shared/customer-service-launch'

const recordSchema = z.object({
  launchId: customerServiceLaunchId,
  claimId: z.string().uuid(),
  phase: z.enum(['claiming', 'launching', 'launched']),
  tabId: z.string().min(1).max(200).optional(),
  ledgerId: z
    .string()
    .regex(/^als_[a-f0-9]{24}$/)
    .optional()
})
export type CustomerServiceLocalLaunch = z.infer<typeof recordSchema>

/** A corrupt or unwritable journal must refuse execution, never reset a consumed claim. */
export class CustomerServiceLaunchStore {
  constructor(private readonly directory: string) {}

  read(key: string): CustomerServiceLocalLaunch | null {
    try {
      return recordSchema.parse(JSON.parse(readFileSync(this.path(key), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  write(key: string, record: CustomerServiceLocalLaunch): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const path = this.path(key)
    writeFileSync(`${path}.tmp`, JSON.stringify(recordSchema.parse(record)), {
      mode: 0o600,
      flush: true
    })
    renameSync(`${path}.tmp`, path)
  }

  private path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) {
      throw new Error('Invalid launch journal key')
    }
    return join(this.directory, `${key}.json`)
  }
}
