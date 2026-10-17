import { getIntlLocale, translate } from '@/i18n/i18n'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

/**
 * Inline markdown as a one-line preview reads it: the words without their markers. Bold, code,
 * strikethrough, headings and link syntax go; a lone `_` stays, because `snake_case` is a word.
 */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "4 min ago", "3 h ago", "2 d ago": how long ago `at` was, as a status reads it. */
export function activityAgeLabel(at: number, now: number): string {
  const age = Math.max(0, now - at)
  if (age < MINUTE) {
    return translate('sessionActivity.justNow', 'just now')
  }
  if (age < HOUR) {
    return translate('sessionActivity.minutesAgo', '{{count}} min ago', {
      count: Math.floor(age / MINUTE)
    })
  }
  if (age < DAY) {
    return translate('sessionActivity.hoursAgo', '{{count}} h ago', {
      count: Math.floor(age / HOUR)
    })
  }
  return translate('sessionActivity.daysAgo', '{{count}} d ago', { count: Math.floor(age / DAY) })
}

let cached: { locale: string; formatter: Intl.DateTimeFormat } | null = null

/** The absolute moment behind a relative age, for a title. */
export function activityAbsoluteTime(at: number): string {
  const locale = getIntlLocale()
  if (!cached || cached.locale !== locale) {
    cached = {
      locale,
      formatter: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
    }
  }
  return cached.formatter.format(new Date(at))
}

/**
 * The prose that ends the transcript, when the assistant's is the last word: the message the
 * person sees right under the activity panel. A prompt after it means the reply is not there yet.
 */
export function latestAssistantText(messages: readonly NativeChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'user') {
      return null
    }
    if (message.role !== 'assistant') {
      continue
    }
    const text = message.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim()
    if (text) {
      return text
    }
  }
  return null
}
