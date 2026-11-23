import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { ApprovalBox } from './ApprovalDialog'
import { clashText, MAX_RESULT_NAMES, replaceAllowed, type ClashRequest } from './upload-model'

/**
 * Names already taken in the upload's folder (design-upload.md §2.3, §5.3) on ApprovalDialog: a panel
 * page can raise this with a `File` it built and time it against a click, so Replace must not take a
 * click aimed at something else. No default button, Enter and Space do nothing inside, Replace and
 * Keep both take a click only after about a second of being seen (Keep both is the box's `alsoAllow`,
 * guarded exactly as Allow is: it writes files too), Esc and Cancel answer Cancel, and a backdrop click
 * answers nothing. Replace is off, with the reason, when a clash is a folder or a link (the box then
 * shows no Allow: `denyOnly`). One answer covers the whole upload; `key` the dialog by request id.
 */
export function UploadClashDialog(props: { request: ClashRequest }): React.JSX.Element {
  return createPortal(<UploadClashBox request={props.request} />, document.body)
}

/** The dialog without its portal (exported for its unit test, which renders it without a DOM). */
export function UploadClashBox(props: { request: ClashRequest }): React.JSX.Element {
  const { request } = props
  const text = clashText(request.folder, request.clashes)
  const canReplace = replaceAllowed(request.clashes)
  const answered = useRef(false)
  const answer = (choice: 'replace' | 'keep-both' | 'cancel'): void => {
    if (answered.current) return
    answered.current = true
    request.onAnswer(choice)
  }
  return (
    <ApprovalBox
      title={text.title}
      allowLabel="Replace"
      denyLabel="Cancel"
      denyOnly={!canReplace}
      alsoAllow={{ label: 'Keep both', testId: 'upload-clash-keep-both', onClick: () => answer('keep-both') }}
      testIds={{ dialog: 'upload-clash', allow: 'upload-clash-replace', deny: 'upload-clash-cancel' }}
      onAnswer={(allow) => answer(allow && canReplace ? 'replace' : 'cancel')}
    >
      {/* Every name, in a list with its own scroll: the title names only a few, and the dialog takes no
          focus, so buttons pushed below the viewport could not be reached at all. */}
      {text.names.length > MAX_RESULT_NAMES ? (
        <ul className="upload-clash-names" aria-label="Files that exist" data-testid="upload-clash-names">
          {text.names.map((name, i) => (
            <li key={i}>{name}</li>
          ))}
        </ul>
      ) : null}
      <p>Keep both numbers the new files: name (1).ext.</p>
      {text.replaceOff !== undefined ? (
        <p className="download-offer-note" data-testid="upload-clash-replace-off">
          {text.replaceOff}
        </p>
      ) : null}
    </ApprovalBox>
  )
}
