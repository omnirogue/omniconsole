import { z } from 'zod'
import { ROOM_RECORD_INSTRUCTION } from './inbox-room-record'

export const ROOM_PURPOSES = {
  help: 'Get help',
  status: 'Assess progress',
  decision: 'Make a decision',
  build: 'Work together',
  review: 'Review work'
} as const

export const RoomBriefSchema = z.object({
  purpose: z.enum(['help', 'status', 'decision', 'build', 'review']),
  outcome: z.string().trim().max(240),
  progress: z.string().trim().max(400),
  attempted: z.string().trim().max(400),
  excerpt: z.string().trim().max(800).optional(),
  references: z
    .array(
      z
        .string()
        .url()
        .refine((value) => {
          const url = new URL(value)
          return url.protocol === 'https:' && !url.username && !url.password
        }, 'Use HTTPS links without credentials.')
    )
    .max(4)
})
export type RoomBrief = z.infer<typeof RoomBriefSchema>
export const EMPTY_ROOM_BRIEF: RoomBrief = {
  purpose: 'help',
  outcome: '',
  progress: '',
  attempted: '',
  references: []
}

export function formatRoomBrief(input: RoomBrief): string {
  const brief = RoomBriefSchema.parse(input)
  return [
    `Purpose: ${ROOM_PURPOSES[brief.purpose]}`,
    brief.outcome && `Expected outcome: ${brief.outcome}`,
    brief.progress && `Current progress: ${brief.progress}`,
    brief.attempted && `Already tried: ${brief.attempted}`,
    brief.excerpt && `Selected session excerpt: ${brief.excerpt}`,
    ...brief.references.map((url) => `Reference: ${url}`)
  ]
    .filter(Boolean)
    .join('\n\n')
}

export const ROOM_FACILITATION_RULES = [
  'Facilitate one round only: ask each relevant participant for evidence, then return to the operator. Do not start another round automatically.',
  'Only the exact opening_message is approved for sharing. context_references identify private source work for the operator; do not read, summarize or transmit additional session history without a separate sharing review.',
  'Publish a concise room recap with: objective, findings with source message IDs, disagreements, unanswered questions, proposed next steps and people who have not replied. Mark proposals as proposals; silence is not agreement.',
  'Use authenticated room history as the record. Read prior recaps and newer messages; if history is incomplete, say so. Never invent a reply, consensus, receipt or completed task.',
  ROOM_RECORD_INSTRUCTION,
  'A room decision does not authorize implementation, deployment or another person’s task. Return the actual room/message receipt and any missing enrollment or tool capability.'
].join('\n\n')
