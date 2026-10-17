import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSessionTags } from '@/store/session-tags'
import { SESSION_TAG_COLORS, type SessionTag } from '@/lib/session-tags'
import { translate } from '@/i18n/i18n'

function TagEditor({ tag }: { tag?: SessionTag }) {
  const store = useSessionTags()
  const [name, setName] = useState(tag?.name ?? '')
  const [color, setColor] = useState(tag?.color ?? SESSION_TAG_COLORS[0])
  const dirty = tag ? name !== tag.name || color !== tag.color : Boolean(name.trim())
  return (
    <form
      className="space-y-2 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault()
        const next = { id: tag?.id ?? crypto.randomUUID(), name: name.trim(), color }
        if (
          store.save({
            ...store.data,
            tags: tag
              ? store.data.tags.map((item) => (item.id === tag.id ? next : item))
              : [...store.data.tags, next]
          }) &&
          !tag
        ) {
          setName('')
        }
      }}
    >
      <div className="flex items-center gap-2">
        <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={40}
          aria-label={translate('sessionTags.name', 'Tag name')}
          placeholder={translate('sessionTags.new', 'New tag')}
          className="h-8"
        />
        <Button
          size="sm"
          variant={tag ? 'outline' : 'default'}
          disabled={!store.loaded || !dirty || !name.trim()}
          type="submit"
        >
          {tag ? (
            translate('sessionTags.save', 'Save')
          ) : (
            <>
              <Plus className="size-3.5" />
              {translate('sessionTags.add', 'Add')}
            </>
          )}
        </Button>
        {tag ? (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!store.loaded}
            type="button"
            aria-label={translate('sessionTags.deleteNamed', 'Delete {{name}}', { name: tag.name })}
            onClick={() =>
              store.save({
                ...store.data,
                tags: store.data.tags.filter((item) => item.id !== tag.id),
                filter: store.data.filter.filter((id) => id !== tag.id),
                assignments: Object.fromEntries(
                  Object.entries(store.data.assignments).map(([key, ids]) => [
                    key,
                    ids.filter((id) => id !== tag.id)
                  ])
                )
              })
            }
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div
        className="flex flex-wrap gap-1"
        role="group"
        aria-label={translate('sessionTags.color', 'Tag color')}
      >
        {SESSION_TAG_COLORS.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={translate('sessionTags.colorValue', 'Color {{color}}', { color: value })}
            aria-pressed={color === value}
            onClick={() => setColor(value)}
            className="flex size-7 items-center justify-center rounded-md border border-transparent aria-pressed:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="size-3 rounded-full" style={{ backgroundColor: value }} />
          </button>
        ))}
      </div>
    </form>
  )
}
export function SessionTagsPane() {
  const store = useSessionTags()
  const { loaded, error, load } = store
  useEffect(() => {
    if (!loaded && !error) {
      load()
    }
  }, [loaded, error, load])
  return (
    <div className="max-w-xl space-y-3">
      <p className="text-sm text-muted-foreground">
        {translate(
          'sessionTags.description',
          'Your tags are saved for your account on this device. Colors appear on chips, so sessions with several tags stay easy to read.'
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {translate(
          'sessionTags.automatic',
          'Company tags are suggested from local company folders until you choose tags for a session. OmniOS is manual.'
        )}
      </p>
      {store.error ? (
        <div role="alert" className="text-sm text-destructive">
          {store.error}
          {!store.loaded ? (
            <Button variant="outline" size="sm" onClick={store.load}>
              {translate('sessionTags.retry', 'Retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {store.data.tags.map((tag) => (
        <TagEditor key={`${store.scope}:${tag.id}`} tag={tag} />
      ))}
      <TagEditor key={`${store.scope}:new`} />
    </div>
  )
}
