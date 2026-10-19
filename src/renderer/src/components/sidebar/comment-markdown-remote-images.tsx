import type { Components } from 'react-markdown'
import { isTrustedCompactImageSrc } from './comment-markdown-element-renderers'
import {
  isDirectAudioLink,
  isDirectVideoLink,
  isGitHubUserAttachmentVideoLink
} from './comment-markdown-github-attachment-media'

function PlainExternalAnchor({
  href,
  children
}: {
  href?: string
  children?: React.ReactNode
}): React.ReactElement {
  return (
    <a
      href={href || undefined}
      target="_blank"
      rel="noreferrer"
      className="break-all text-primary underline underline-offset-2 hover:text-primary/80"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  )
}

// Why: a remote image or media embed loads on sight, so model-written markdown
// in untrusted/deliverable views could send data out in its address.
export function withRemoteImagesAsLinks(components: Components): Components {
  const Image = components.img
  const Anchor = components.a
  return {
    ...components,
    a: (props) => {
      if (
        isGitHubUserAttachmentVideoLink(props.href, props.children) ||
        isDirectVideoLink(props.href) ||
        isDirectAudioLink(props.href)
      ) {
        return <PlainExternalAnchor href={props.href}>{props.children}</PlainExternalAnchor>
      }
      return typeof Anchor === 'function' ? (
        <Anchor {...props} />
      ) : (
        <PlainExternalAnchor href={props.href}>{props.children}</PlainExternalAnchor>
      )
    },
    img: (props) => {
      if (isTrustedCompactImageSrc(props.src)) {
        return typeof Image === 'function' ? (
          <Image {...props} />
        ) : (
          <img src={props.src} alt={props.alt ?? ''} />
        )
      }
      if (!props.src) {
        return props.alt ? <span>{props.alt}</span> : null
      }
      return <PlainExternalAnchor href={props.src}>{props.alt || props.src}</PlainExternalAnchor>
    }
  }
}
