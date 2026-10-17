import type { Components } from 'react-markdown'
import { isTrustedCompactImageSrc } from './comment-markdown-element-renderers'

// Why: a remote image loads on sight, so model-written markdown could send data out in its address.
export function withRemoteImagesAsLinks(components: Components): Components {
  const Image = components.img
  const Anchor = components.a
  return {
    ...components,
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
      const link = { href: props.src, children: props.alt || props.src }
      return typeof Anchor === 'function' ? (
        <Anchor {...link} />
      ) : (
        <a {...link} target="_blank" rel="noreferrer" />
      )
    }
  }
}
