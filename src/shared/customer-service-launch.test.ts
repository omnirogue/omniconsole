import { expect, it } from 'vitest'
import {
  customerServiceLaunchSchema,
  parseCustomerServiceLaunchLink
} from './customer-service-launch'

const id = `csl_${'a'.repeat(32)}`
it('accepts the full filtered selection while keeping the brief and ID list bounded', () => {
  const launch = {
    launch_id: id,
    status: 'prepared',
    company: { slug: 'acme', name: 'ACME' },
    brief: 'Review the selected issues at the immutable saved batch link.',
    ticket_ids: Array.from({ length: 50_000 }, (_, index) => index + 1),
    claim_id: null,
    session_ledger_id: null
  }
  expect(customerServiceLaunchSchema.safeParse(launch).success).toBe(true)
  expect(
    customerServiceLaunchSchema.safeParse({ ...launch, ticket_ids: [...launch.ticket_ids, 50_001] })
      .success
  ).toBe(false)
  expect(
    customerServiceLaunchSchema.safeParse({ ...launch, brief: 'x'.repeat(100_001) }).success
  ).toBe(false)
})
it('accepts only an opaque launch lookup, without execution parameters', () => {
  expect(parseCustomerServiceLaunchLink(`omni://customer-service/launch/${id}`)).toBe(id)
  for (const link of [
    `https://customer-service/launch/${id}`,
    `omni://customer-service/launch/${id}?prompt=run`,
    `omni://customer-service/launch/${id}#employee=sal`,
    `omni://attacker@customer-service/launch/${id}`,
    'omni://customer-service/launch/../../run',
    'omni://customer-service/launch/csl_bad',
    `omni://customer-service/launch/${id}/`
  ]) {
    expect(parseCustomerServiceLaunchLink(link)).toBeNull()
  }
})
