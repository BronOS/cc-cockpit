import { useEffect, useRef, useState } from 'react'
import { ownPreviewUrl, previewInitial, type PreviewSource } from './plugin-preview'

/**
 * A plugin card's preview image (design-next §6.1), or a neutral placeholder with the name's initial.
 * Lazy: nothing is asked until the card is on screen, so a long list costs one fetch per card the user
 * actually scrolls to. A listing's bytes come from main (fetched from the index's own folder, hash
 * checked, cached) and are shown from a `blob:` URL that is revoked when the card goes; an installed
 * plugin's own file loads through `cc-plugin://`. Any failure, including an image the browser cannot
 * decode, falls back to the placeholder.
 */
export function PluginPreview(props: { name: string; source: PreviewSource | null }): React.JSX.Element {
  const { source } = props
  if (source === null) return <Placeholder name={props.name} />
  // Keyed by the source: another listing in the same row starts over (not visible, no image, not failed).
  const key = source.kind === 'own' ? `own:${source.id}` : `listing:${source.indexUrl}|${source.id}`
  return <LazyPreview key={key} name={props.name} source={source} />
}

function Placeholder(props: { name: string }): React.JSX.Element {
  return (
    <div className="plugin-preview placeholder" data-testid="plugin-preview">
      <span aria-hidden="true">{previewInitial(props.name)}</span>
    </div>
  )
}

function LazyPreview(props: { name: string; source: PreviewSource }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  // No IntersectionObserver (an old engine): load at once rather than never.
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const { kind, id } = props.source
  const indexUrl = props.source.kind === 'listing' ? props.source.indexUrl : ''

  useEffect(() => {
    const el = box.current
    if (visible || el === null) return
    const io = new IntersectionObserver((seen) => {
      if (seen.some((e) => e.isIntersecting)) {
        setVisible(true)
        io.disconnect()
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [visible])

  useEffect(() => {
    if (kind !== 'listing' || !visible) return
    let live = true
    let url: string | null = null
    window.cockpit.invoke('settings.marketplacePreview', { indexUrl, id }).then(
      (bytes) => {
        if (!live) return
        if (bytes === null) return setFailed(true)
        // A copy: Blob wants an ArrayBuffer-backed view, and IPC may hand over a view of a larger buffer.
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
        setBlobUrl(url)
      },
      () => {
        if (live) setFailed(true)
      }
    )
    return () => {
      live = false
      if (url !== null) URL.revokeObjectURL(url)
    }
  }, [kind, indexUrl, id, visible])

  const src = kind === 'own' ? (visible ? ownPreviewUrl(id) : null) : blobUrl
  const shown = src !== null && !failed
  // One box for both states: the observer watches it until the card is first on screen.
  return (
    <div ref={box} className={shown ? 'plugin-preview' : 'plugin-preview placeholder'} data-testid="plugin-preview">
      {shown ? (
        <img src={src} alt="" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <span aria-hidden="true">{previewInitial(props.name)}</span>
      )}
    </div>
  )
}
