import { z } from 'zod'

const nullableText = z.string().nullable().optional()

// ── the work folders (GET /api/work/folders) ──────────────────────────────────
// The console's folder tree: only the companies work is filed under. Decoded
// loosely — the desktop needs the identities, not the tree.
/** A project inside a department: the third and last filing level a person sees. */
export const workFolderProject = z
  .object({
    id: nullableText,
    name: nullableText,
    kind: nullableText,
    status: nullableText,
    parent_project_id: nullableText
  })
  .passthrough()
export const workFolderDomain = z
  .object({
    id: nullableText,
    name: nullableText,
    count: z.number().nullable().optional(),
    parent_unit_id: nullableText,
    // Why: null means "the tree does not know", which is not the same as "none".
    projects: z.array(workFolderProject).nullable().optional()
  })
  .passthrough()
export const workFolderCompany = z
  .object({
    id: nullableText,
    slug: nullableText,
    name: nullableText,
    status: nullableText,
    count: z.number().nullable().optional(),
    domains: z.array(workFolderDomain).default([])
  })
  .passthrough()
export const workFolders = z
  .object({
    ok: z.boolean().default(true),
    reason: nullableText,
    companies: z.array(workFolderCompany).default([])
  })
  .passthrough()

export type WorkFolders = z.infer<typeof workFolders>
export type WorkFolderCompany = z.infer<typeof workFolderCompany>
export type WorkFolderDomain = z.infer<typeof workFolderDomain>
export type WorkFolderProject = z.infer<typeof workFolderProject>
