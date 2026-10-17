import { expect, it, vi } from 'vitest'
import { deliverSessionFollowUp, type FollowUpDeliveryContext } from './session-follow-up-delivery'
import {
  normalizeSessionChainHandoffStep,
  type SessionFollowUpRule
} from './session-follow-up-rule'
import { handoffSend, handoffSendCardless } from './console-handoff-contract'

it.each(['ownership-transfer', 'feedback'] as const)(
  'delivers %s through both strict send payloads',
  async (disposition) => {
    for (const taskId of ['btk_card1234', null]) {
      let rule: SessionFollowUpRule = {
        revision: 1,
        taskId,
        taskTitle: 'Result',
        sessionLabel: 'Source',
        disposition,
        recipients: [
          {
            employeeId: 'emp_person',
            name: 'Person',
            operationId: 'operation_1234',
            delivery: 'pending'
          }
        ],
        action: 'review',
        deliverables: { kind: 'files', paths: [] },
        includeSummary: false,
        note: 'Read the result.',
        savedAt: 1,
        capturedAt: 2,
        files: []
      }
      const ctx: FollowUpDeliveryContext = {
        current: () => rule,
        save: async (value) => {
          rule = value
        },
        hub: {
          send: vi.fn(async (payload) => {
            expect(handoffSend.parse(payload)).toMatchObject({ disposition })
            expect(payload).not.toHaveProperty('references')
            return { thread_id: 'hth_thread1234' }
          }),
          sendCardless: vi.fn(async (payload) => {
            expect(handoffSendCardless.parse(payload)).toMatchObject({ disposition })
            expect(payload).not.toHaveProperty('references')
            return { thread_id: 'hth_thread1234' }
          }),
          upload: vi.fn(),
          uploadThreadFile: vi.fn(),
          isRejected: () => true
        },
        bytes: vi.fn(),
        now: () => 3,
        sleep: vi.fn()
      }
      expect(await deliverSessionFollowUp(ctx)).toBe('delivered')
      expect(rule.recipients[0]!.ownershipTransferredAt).toBe(
        disposition === 'ownership-transfer' ? 3 : undefined
      )
      expect(
        normalizeSessionChainHandoffStep({
          id: 'old-handoff',
          kind: 'handoff',
          status: 'skipped',
          planVersion: 1,
          supersededBy: 2,
          handoff: rule
        })
      ).toMatchObject({ status: 'skipped', planVersion: 1, supersededBy: 2 })
    }
  }
)
