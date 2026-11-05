import { useEffect, useRef, useState } from 'react'
import type { SlotFrameInfo } from '../../shared/ipc'
import { requestSlotPort } from '../plugins/panel-port-bus'
import { PluginFrame } from '../plugins/PluginFrame'
import { SlotHeightRelay, slotFrameHeight, slotHeightRequest, slotIntro } from './slot-layout'

/**
 * One slot frame (design-next §2): the PROVIDER's page in a sandboxed iframe (PluginFrame, the
 * panel loader), with its own port to the provider's backend that main hands out on every load
 * (`slots.connect`, panel-port-bus.ts). The host panel draws nothing of it and gets no handle on
 * it; the shell does, so a sandboxed panel page never has to frame anything.
 *
 * - Every load tells the page it is a slot of its type (`cc-plugin.slot`) just before the port.
 * - A column frame is `slotFrameHeight` tall (less when the panel is short: styles.css caps the
 *   column's share); the page's `ccPanel.slot.setHeight` goes to main
 *   (`slots.height`, SlotHeightRelay), which publishes the clamped `pageHeight` back.
 * - The top bar's frame has the bar's height (CSS) and no height requests: main refuses them.
 *   It passes `collapseUntilConnected`: the frame takes no room until main handed its page a port
 *   (`data-connected`, styles.css), so a frame whose connect main refuses (its provider not running,
 *   or the frame no longer drawn) leaves the bar as it is with no provider (the "+" and the gear),
 *   not a blank gap that would not even drag the window on macOS.
 *   The page still loads while collapsed (the iframe is only 0 px wide), so it can connect.
 * - Unmounting (the host panel hidden, its zone collapsed, the placement gone) tells main, and the
 *   provider hears `onClose`. A new frame id from main is a new frame: the caller keys by `id`.
 */
export function SlotFrame(props: { frame: SlotFrameInfo; collapseUntilConnected?: boolean }): React.JSX.Element {
  const { frame } = props
  // Set once a port reached this frame; a new frame id is a new component (the caller keys by id).
  const [connected, setConnected] = useState(false)
  const topBar = frame.position === 'top-bar'
  const latest = useRef(frame)
  useEffect(() => {
    latest.current = frame
  })
  const relay = useRef<SlotHeightRelay | undefined>(undefined)

  useEffect(() => {
    const frameId = frame.id
    const heights = new SlotHeightRelay((height) => window.cockpit.invoke('slots.height', { frameId, height }))
    relay.current = heights
    return () => {
      heights.close()
      if (relay.current === heights) relay.current = undefined
      window.cockpit
        .invoke('slots.disconnect', { frameId })
        .catch((err: unknown) => console.warn(`slots.disconnect ${frameId} failed`, err))
    }
  }, [frame.id])

  const onPageMessage = (data: unknown): void => {
    if (topBar) return
    const height = slotHeightRequest(data, latest.current)
    if (height !== undefined) relay.current?.request(height)
  }

  return (
    <div
      className={topBar ? 'slot-frame-wrap slot-frame-top-bar' : 'slot-frame-wrap'}
      data-slot-frame={frame.id}
      data-slot-type={frame.type}
      data-slot-plugin={frame.pluginId}
      data-connected={connected ? '' : undefined}
      data-collapsible={props.collapseUntilConnected === true ? '' : undefined}
      style={topBar ? undefined : { height: slotFrameHeight(frame) }}
    >
      <PluginFrame
        src={frame.src}
        title={`${frame.type} slot`}
        className="slot-frame"
        intro={slotIntro(frame.type)}
        onPageMessage={onPageMessage}
        connect={(deliver) =>
          requestSlotPort(frame.id, (port) => {
            setConnected(true)
            deliver(port)
          })
        }
      />
    </div>
  )
}

/** A panel's slot frames on one side of its own frame, in placement order. */
export function SlotFrames(props: { frames: readonly SlotFrameInfo[]; position: 'top' | 'bottom' }): React.JSX.Element | null {
  if (props.frames.length === 0) return null
  return (
    <div className={`slot-frames slot-frames-${props.position}`}>
      {props.frames.map((frame) => (
        <SlotFrame key={frame.id} frame={frame} />
      ))}
    </div>
  )
}
