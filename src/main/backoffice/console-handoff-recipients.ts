import { z } from 'zod'
import type { ConsoleHandoffApi } from '../../shared/console-handoff-contract'
import { requestConsoleWorkflow as request } from './console-workflow-transport'

// Who Add Next may hand work to. Three doors, tried in order: the console's people directory,
// an admin's own sign-in list while that directory is not served, and the hub employees table last.
const ROOT = '/api/gtd/hub/api'
/** Directory refusals that mean "ask the employees list instead", never "show nobody". */
const DIRECTORY_FALLBACK_CODES = [
  'capability_unavailable',
  'not_served',
  'invalid_response',
  // Why: the console answers 503 with this tag while its RBAC store is down (omni-console #414).
  'rbac_store_unavailable',
  'rbac-store-unavailable'
]

// Why: the admin users list reads the same RBAC store as the recipients route, so it is only worth
// asking when that route is missing, never while the store itself is down.
function shouldReadAdminUsers(error: { status?: number; code: string }): boolean {
  return (
    error.status === 404 ||
    ['capability_unavailable', 'not_served', 'invalid_response'].includes(error.code)
  )
}
function shouldReadEmployees(error: { status?: number; code: string }): boolean {
  if (error.status === 404 || error.status === 503) {
    return true
  }
  if ([401, 403].includes(error.status ?? 0)) {
    return false
  }
  // Why: a directory that answers in an unexpected shape must not blank the picker.
  return DIRECTORY_FALLBACK_CODES.includes(error.code)
}
const optionalText = z
  .string()
  .nullish()
  .transform((value) => value?.trim() || undefined)
const person = z.object({
  id: z.string().regex(/^emp_[A-Za-z0-9_-]{1,120}$/),
  name: z.string(),
  role: optionalText,
  title: optionalText,
  department: optionalText,
  photo_url: optionalText,
  image_url: optionalText,
  companies: z.array(z.string()).nullish()
})
// Why: until the console serves /api/work/recipients, an admin's own users list IS the sign-in
// directory; members get 403 there and keep the employees fallback.
const adminUsers = z
  .object({
    users: z.array(
      z.object({
        role: z.string().nullish(),
        employee_id: z.string().nullish(),
        name: z.string().nullish(),
        email: z.string().nullish(),
        photo_url: optionalText,
        image_url: optionalText,
        companies: z.array(z.string()).nullish(),
        // Why: a row Clerk no longer lists is a deleted sign-in, kept only for the admin panel.
        missing_in_clerk: z.boolean().nullish()
      })
    )
  })
  .transform(({ users }) => ({
    employees: users.flatMap((user) => {
      const id = user.employee_id ?? ''
      if (
        user.missing_in_clerk ||
        !['admin', 'member'].includes(user.role ?? '') ||
        !/^emp_[A-Za-z0-9_-]{1,120}$/.test(id)
      ) {
        return []
      }
      return [
        {
          id,
          name: user.name?.trim() || user.email?.trim() || id,
          ...(user.photo_url || user.image_url
            ? { photo_url: user.photo_url || user.image_url }
            : {}),
          ...(user.companies ? { companies: user.companies } : {})
        }
      ]
    }),
    peopleSource: 'admin-directory' as const
  }))
const employees = z.object({
  employees: z
    .array(person.extend({ status: z.string().nullish(), kind: z.string().nullish() }))
    .transform((rows) => rows.filter((row) => row.status === 'active' && row.kind === 'human'))
})

export const readHandoffRecipients: ConsoleHandoffApi['recipients'] = async () => {
  const directory = await request(
    '/api/work/recipients',
    'GET',
    z.object({ recipients: z.array(person) }).transform(({ recipients }) => ({
      employees: recipients,
      peopleSource: 'directory' as const
    }))
  )
  if (directory.ok || !shouldReadEmployees(directory.error)) {
    return directory
  }
  if (shouldReadAdminUsers(directory.error)) {
    const admin = await request('/api/admin/users', 'GET', adminUsers)
    if (admin.ok) {
      return admin
    }
  }
  const legacy = await request(`${ROOT}/employees`, 'GET', employees)
  return legacy.ok
    ? { ...legacy, data: { ...legacy.data, peopleSource: 'employees' as const } }
    : legacy
}
