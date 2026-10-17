import { z } from 'zod'
import type { ConsoleWorkflowResult } from './console-workflow-types'

export const customerServiceLaunchId = z.string().regex(/^csl_[a-f0-9]{32}$/)
export const customerServiceLaunchSchema = z.object({
  launch_id: customerServiceLaunchId,
  status: z.enum(['prepared', 'claimed', 'launched']),
  company: z.object({ slug: z.string().min(1).max(100), name: z.string().min(1).max(200) }),
  brief: z.string().min(1).max(100_000),
  ticket_ids: z.array(z.number().int().positive()).min(1).max(50_000),
  claim_id: z.string().uuid().nullable(),
  session_ledger_id: z
    .string()
    .regex(/^als_[a-f0-9]{24}$/)
    .nullable()
})
export type CustomerServiceLaunch = z.infer<typeof customerServiceLaunchSchema>
export type CustomerServicePreview = {
  launch: CustomerServiceLaunch
  previewKey: string
  localState: 'ready' | 'unverifiable' | 'receipt-pending' | 'launched'
}
export type CustomerServiceLaunchApi = {
  onOpen(listener: (id: string) => void): () => void
  consumePending(): Promise<string | null>
  preview(id: string): Promise<ConsoleWorkflowResult<CustomerServicePreview>>
  begin(args: { previewKey: string }): Promise<ConsoleWorkflowResult<CustomerServiceLaunch>>
  receipt(args: {
    previewKey: string
    tabId?: string
  }): Promise<ConsoleWorkflowResult<CustomerServiceLaunch>>
}

/** The link carries only an opaque lookup key; the signed-in desktop retrieves the brief. */
export function parseCustomerServiceLaunchLink(value: string): string | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'omni:' ||
      url.hostname !== 'customer-service' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return null
    }
    const match = /^\/launch\/(csl_[a-f0-9]{32})$/.exec(url.pathname)
    return match?.[1] ?? null
  } catch {
    return null
  }
}
