import {
  advertisingActionCapabilities,
  advertisingActionCapabilitiesRequest,
  advertisingActionExecuteRequest,
  advertisingActionPreview,
  advertisingActionPreviewRequest,
  advertisingActionReadRequest,
  advertisingActionReceipt,
  type AdvertisingActionScope,
  type ConsoleAdvertisingActionsApi
} from '../../shared/console-advertising-actions-contract'
import { requestConsoleWorkflow as request, validated } from './console-workflow-transport'

const actionPath = '/api/gtd/hub/api/actions'

function sameScope(value: AdvertisingActionScope, expected: AdvertisingActionScope): boolean {
  return (
    value.verb === expected.verb &&
    value.target.domain === expected.target.domain &&
    value.target.company === expected.target.company &&
    value.target.type === expected.target.type &&
    value.target.id === expected.target.id
  )
}

/** Signed delegation and advertising intent are owned by the BFF. */
export const consoleAdvertisingActionsClient: ConsoleAdvertisingActionsApi = {
  capabilities: (args, principal) =>
    validated(args, advertisingActionCapabilitiesRequest, (input) =>
      request(
        `${actionPath}/capabilities?domain=advertising&company=${input.company}`,
        'GET',
        advertisingActionCapabilities,
        undefined,
        15_000,
        false,
        principal
      )
    ),
  preview: (args, principal) =>
    validated(args, advertisingActionPreviewRequest, (input) =>
      request(
        `${actionPath}/preview`,
        'POST',
        advertisingActionPreview.refine(
          (value) => sameScope(value, input),
          'The advertising preview belongs to a different action or target.'
        ),
        { ...input, parameters: {} },
        45_000,
        true,
        principal
      )
    ),
  get: (args, principal) =>
    validated(args, advertisingActionReadRequest, (input) =>
      request(
        `${actionPath}/${input.id}`,
        'GET',
        scopedReceipt(input),
        undefined,
        15_000,
        true,
        principal
      )
    ),
  execute: (args, principal) =>
    validated(args, advertisingActionExecuteRequest, (input) =>
      request(
        `${actionPath}/${input.id}/execute`,
        'POST',
        scopedReceipt(input)
          .refine(
            (value) => value.preview.revision === input.expected_revision,
            'The execution receipt belongs to a different reviewed revision.'
          )
          .refine(
            (value) => value.execution?.idempotency_key === input.idempotency_key,
            'The execution receipt belongs to a different request.'
          ),
        {
          expected_revision: input.expected_revision,
          idempotency_key: input.idempotency_key,
          approved: input.approved
        },
        45_000,
        true,
        principal
      )
    ),
  verify: (args, principal) =>
    validated(args, advertisingActionReadRequest, (input) =>
      request(
        `${actionPath}/${input.id}/verify`,
        'POST',
        scopedReceipt(input),
        {},
        45_000,
        true,
        principal
      )
    )
}

function scopedReceipt(input: AdvertisingActionScope & { id: string }) {
  return advertisingActionReceipt.refine(
    (value) => value.id === input.id && sameScope(value.preview, input),
    'The advertising receipt belongs to a different action or target.'
  )
}
