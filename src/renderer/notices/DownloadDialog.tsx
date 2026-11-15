import { useState } from 'react'
import { ApprovalDialog } from './ApprovalDialog'
import { downloadDialogText, offerAcceptPayload } from './download-dialog-model'
import type { DownloadOffer } from '../../shared/downloads'

/**
 * The `ccc download` offer (design-download.md §2.2) on ApprovalDialog: Download is never the default,
 * Enter and Space do nothing inside, Download takes a click only after about a second of being seen,
 * and a backdrop click answers nothing, because the person may be typing to Claude when it appears.
 * The path is shown whole and wrapped (monospace, never cut), the real path beside it when the named
 * one is a link, and the include checkbox starts unchecked whatever Claude asked. The tab title is
 * not shown: the offer is the project's. `key` the dialog by request id so the checkbox resets.
 * Known limit: ApprovalDialog blocks Space, so the checkbox toggles by click only; the unchecked default is the safe one.
 */
export function DownloadDialog(props: { offer: DownloadOffer; onAnswer(accept: { all: boolean } | undefined): void }): React.JSX.Element {
  const { offer } = props
  const text = downloadDialogText(offer)
  const [include, setInclude] = useState(false)
  return (
    <ApprovalDialog
      title={text.title}
      allowLabel="Download"
      denyLabel="Cancel"
      testIds={{ dialog: 'download-offer', allow: 'download-offer-accept', deny: 'download-offer-cancel' }}
      onAnswer={(allow) => props.onAnswer(allow ? { all: offerAcceptPayload(offer, include).all } : undefined)}
    >
      <p>{text.kindLine}</p>
      <p className="download-offer-path" data-testid="download-offer-path">
        {text.path}
      </p>
      {text.real !== undefined ? (
        <p>
          A link to <span className="download-offer-path">{text.real}</span>
        </p>
      ) : null}
      {text.outsideLine !== undefined ? <p className="download-offer-warn">{text.outsideLine}</p> : null}
      <p>{text.sizeLine}</p>
      {text.skippedLine !== undefined ? <p>{text.skippedLine}</p> : null}
      {text.runnableLine !== undefined ? <p className="download-offer-warn">{text.runnableLine}</p> : null}
      {text.includeLabel !== undefined ? (
        <label className="confirm-check">
          <input
            type="checkbox"
            data-testid="download-offer-include"
            checked={include}
            disabled={offer.kind === 'folder' && offer.allTooLarge === true}
            onChange={(e) => setInclude(e.target.checked)}
          />{' '}
          {text.includeLabel}
          {text.includeNote !== undefined ? <span className="download-offer-note"> {text.includeNote}</span> : null}
        </label>
      ) : null}
    </ApprovalDialog>
  )
}
