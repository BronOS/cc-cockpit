import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { downloadSizeText } from '../../shared/downloads'
import type { UploadFoldersReply } from '../../shared/uploads'
import { stripUnsafe } from './download-dialog-model'
import { chooserHeading, childPath, folderLabel, moreFoldersText, startingFolder, type ChooserRequest } from './upload-model'

type Listings = ReadonlyMap<string, UploadFoldersReply>

/**
 * The folder chooser (design-upload.md §4.2): "Upload 2 files (3.1 MB) to" above a tree of the project's
 * folders, the files with their sizes, Upload and Cancel. An ordinary dialog, not an ApprovalDialog: only
 * the person's own drop or paste opens it and nothing it does is risky. It takes the focus (the person
 * just dropped something and nothing is being typed), Enter uploads and Esc cancels. The tree is listed
 * lazily through the terminal tab (`uploads.folders`), subfolder names only; the preset opens on the
 * folder this device last used for the project when it still lists, else the project folder.
 */
export function UploadDialog(props: { request: ChooserRequest }): React.JSX.Element {
  const { request } = props
  const [listings, setListings] = useState<Listings>(new Map())
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set(['']))
  const [selected, setSelected] = useState('')
  // Upload waits for the preset's listing: an Enter before it would send to the project folder.
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set())
  const answered = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  const list = (path: string) => window.cockpit.invoke('uploads.folders', { tab: request.tab, path })

  useEffect(() => {
    let live = true
    void startingFolder(request.preset, list).then((start) => {
      if (!live) return
      setListings(start.listings)
      const opened = new Set(['', ...start.listings.keys()])
      setOpen(opened)
      setSelected(start.folder)
      setReady(true)
    })
    root.current?.focus()
    return () => {
      live = false
    }
    // The preset is read once: a dialog's request never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const answer = (folder: string | undefined): void => {
    if (answered.current) return
    answered.current = true
    request.onAnswer(folder)
  }

  const toggle = (path: string): void => {
    if (open.has(path)) {
      setOpen((prev) => new Set([...prev].filter((p) => p !== path)))
      return
    }
    setOpen((prev) => new Set([...prev, path]))
    if (listings.has(path)) return
    setLoading((prev) => new Set([...prev, path]))
    void list(path)
      .then((reply) => {
        if (!('error' in reply)) setListings((prev) => new Map([...prev, [path, reply]]))
      })
      .catch(() => {})
      .finally(() => setLoading((prev) => new Set([...prev].filter((p) => p !== path))))
  }

  const rows = (parent: string, depth: number): React.JSX.Element[] => {
    const reply = listings.get(parent)
    if (reply === undefined) return []
    const out: React.JSX.Element[] = []
    for (const name of reply.folders) {
      const path = childPath(parent, name)
      const isOpen = open.has(path)
      out.push(
        <li key={path} role="treeitem" aria-expanded={isOpen} aria-selected={selected === path}>
          <div className={`upload-folder-row${selected === path ? ' selected' : ''}`} style={{ paddingLeft: depth * 14 }}>
            <button type="button" className="upload-folder-twist" aria-label={isOpen ? `Collapse ${stripUnsafe(name)}` : `Expand ${stripUnsafe(name)}`} onClick={() => toggle(path)}>
              {loading.has(path) ? '…' : isOpen ? '▾' : '▸'}
            </button>
            <button type="button" className="upload-folder-name" data-testid="upload-folder" onClick={() => setSelected(path)} onDoubleClick={() => toggle(path)}>
              {stripUnsafe(name)}
            </button>
          </div>
          {isOpen ? <ul role="group">{rows(path, depth + 1)}</ul> : null}
        </li>
      )
    }
    if (reply.more) {
      out.push(
        <li key={`${parent}\0more`} className="upload-folder-more" style={{ paddingLeft: depth * 14 }}>
          {moreFoldersText()}
        </li>
      )
    }
    return out
  }

  return createPortal(
    <div className="confirm-backdrop confirm-over-all" data-testid="upload-backdrop">
      <div
        ref={root}
        className="confirm-dialog upload-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Upload"
        tabIndex={-1}
        data-testid="upload-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            answer(undefined)
          } else if (e.key === 'Enter' && ready && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault()
            e.stopPropagation()
            answer(selected)
          }
        }}
      >
        <h2 className="confirm-title">{chooserHeading(request.files)}</h2>
        <ul className="upload-folder-tree" role="tree" aria-label="Folders">
          <li role="treeitem" aria-selected={selected === ''}>
            <div className={`upload-folder-row${selected === '' ? ' selected' : ''}`}>
              <button type="button" className="upload-folder-name" data-testid="upload-folder-root" onClick={() => setSelected('')}>
                {folderLabel('')}
              </button>
            </div>
            <ul role="group">{rows('', 1)}</ul>
          </li>
        </ul>
        <ul className="upload-files" aria-label="Files">
          {request.files.map((f, i) => (
            <li key={i}>
              <span className="upload-file-name">{stripUnsafe(f.name)}</span> <span className="upload-file-size">{downloadSizeText(f.size)}</span>
            </li>
          ))}
        </ul>
        <div className="confirm-buttons">
          <button type="button" data-testid="upload-cancel" onClick={() => answer(undefined)}>
            Cancel
          </button>
          <button type="button" className="confirm-danger" data-testid="upload-go" disabled={!ready} onClick={() => answer(selected)}>
            Upload
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
