export function slugify(title, options = {}) {
  if (typeof title !== 'string') {
    throw new TypeError('title must be a string')
  }
  const maxLength = options.maxLength ?? 60
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
  return slug === '' ? 'untitled' : slug
}
