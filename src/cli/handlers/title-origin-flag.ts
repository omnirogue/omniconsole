import {
  ORGANIZATION_TITLE_ORIGINS,
  type OrganizationTitleOrigin
} from '../../shared/session-organization-change'
import type { HandlerContext } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

/** `--origin` / `--title-origin`: whose words a title is; absent reads as unknown on the host. */
export function titleOriginFlag(
  flags: HandlerContext['flags'],
  name: 'origin' | 'title-origin'
): OrganizationTitleOrigin | undefined {
  const raw = getOptionalStringFlag(flags, name)
  if (raw === undefined) {
    return undefined
  }
  if (!(ORGANIZATION_TITLE_ORIGINS as readonly string[]).includes(raw)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${name} must be yours (the person gave the words), generated (you wrote them) or unknown.`
    )
  }
  return raw as OrganizationTitleOrigin
}
