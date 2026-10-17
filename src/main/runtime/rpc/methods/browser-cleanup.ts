import { z } from 'zod'
import { defineMethod } from '../core'

export const BROWSER_CLEANUP_METHOD = defineMethod({
  name: 'browser.cleanup',
  params: z.discriminatedUnion('action', [
    z.object({ action: z.literal('preview'), mode: z.enum(['unused', 'all']) }).strict(),
    z.object({ action: z.literal('apply'), token: z.string().uuid() }).strict()
  ]),
  handler: async (params, { runtime }) => runtime.browserCleanup(params)
})
