import { z } from 'zod'
import {
  addSiteRequest,
  browserLoginStatus,
  browserProfile,
  browserProfileId,
  browserProfilesList,
  verifyAllReport,
  type BrowserLoginStatus,
  type BrowserLoginsApi
} from '../../shared/browser-logins-contract'
import { requestConsoleWorkflow as request, validated } from './console-workflow-transport'

const profileRequest = z.object({ profile_id: browserProfileId }).strict()
const openRequest = z
  .object({ profile_id: browserProfileId, reconnect: z.boolean().optional() })
  .strict()
const revisionRequest = z
  .object({ profile_id: browserProfileId, expected_revision: z.number().int().min(0) })
  .strict()

/** The answer must be about the profile that was asked for. */
function answersFor(profileId: string): (value: BrowserLoginStatus) => boolean {
  return (value) => value.profile_id === profileId
}

/**
 * The browser-login rail, read and driven through the desktop's signed backoffice
 * transport: shared AirTop profiles, their live login state, and the re-login
 * flow (open the live view, save once the person signs in, verify it stuck).
 * The hub decides every question of authority; this client only shapes the
 * request and validates the answer, so a wrong-profile answer can never be
 * painted as the one asked for.
 */
export const browserLoginsClient: BrowserLoginsApi = {
  list: () => request('/api/connections/browser-profiles', 'GET', browserProfilesList),
  status: (args) =>
    validated(args, profileRequest, (input) =>
      request(
        `/api/connections/browser-profiles/${input.profile_id}`,
        'GET',
        browserLoginStatus.refine(answersFor(input.profile_id))
      )
    ),
  open: (args) =>
    validated(args, openRequest, (input) =>
      request(
        `/api/connections/browser-profiles/${input.profile_id}/open`,
        'POST',
        browserLoginStatus.refine(answersFor(input.profile_id)),
        { reconnect: input.reconnect ?? false }
      )
    ),
  save: (args) =>
    validated(args, revisionRequest, (input) =>
      request(
        `/api/connections/browser-profiles/${input.profile_id}/save`,
        'POST',
        browserLoginStatus.refine(answersFor(input.profile_id)),
        { expected_revision: input.expected_revision }
      )
    ),
  verify: (args) =>
    validated(args, revisionRequest, (input) =>
      request(
        `/api/connections/browser-profiles/${input.profile_id}/verify`,
        'POST',
        browserLoginStatus.refine(answersFor(input.profile_id)),
        { expected_revision: input.expected_revision }
      )
    ),
  add: (args) =>
    validated(args, addSiteRequest, (input) =>
      request(
        '/api/connections/browser-profiles',
        'POST',
        browserProfile.refine((value) => value.profile_id === input.profile_id),
        input
      )
    ),
  verifyAll: () => request('/api/admin/browser-profiles/verify-all', 'POST', verifyAllReport)
}
