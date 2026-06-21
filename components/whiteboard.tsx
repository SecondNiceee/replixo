"use client"

import { useCallback, useEffect, useRef } from "react"
import { Tldraw, getSnapshot, loadSnapshot } from "tldraw"
import type { Editor, RecordsDiff, TLRecord, TLUiAssetUrls } from "tldraw"
import "tldraw/tldraw.css"

// ---------------------------------------------------------------------------
// Self-host ALL tldraw static assets from our own domain instead of
// cdn.tldraw.com. This prevents "Could not load assets" errors for users
// whose networks block external CDNs.
//
// We pass these as the `assetUrls` prop directly to <Tldraw> rather than
// using the global setDefaultUiAssetUrls() setter so there is zero chance of
// a race condition: the URLs are always available when the component renders.
//
// The complete icon list is derived from tldraw's own icon-types source so it
// stays in sync with whichever version is installed.
// ---------------------------------------------------------------------------
const TLDRAW_BASE = "/tldraw-assets"

// Complete list of icons shipped with tldraw 2.4.4 (matches icon-types.mjs).
const ALL_ICON_NAMES = [
  "align-bottom","align-center-horizontal","align-center-vertical","align-left","align-right","align-top",
  "arrow-left","arrowhead-arrow","arrowhead-bar","arrowhead-diamond","arrowhead-dot","arrowhead-none",
  "arrowhead-square","arrowhead-triangle-inverted","arrowhead-triangle","blob","bring-forward","bring-to-front",
  "broken","check-circle","check","chevron-down","chevron-left","chevron-right","chevron-up",
  "chevrons-ne","chevrons-sw","clipboard-copied","clipboard-copy","color","cross-2","cross-circle",
  "dash-dashed","dash-dotted","dash-draw","dash-solid","disconnected","discord","distribute-horizontal",
  "distribute-vertical","dot","dots-horizontal","dots-vertical","drag-handle-dots","duplicate","edit",
  "external-link","fill-fill","fill-none","fill-pattern","fill-semi","fill-solid","follow","following",
  "font-draw","font-mono","font-sans","font-serif","geo-arrow-down","geo-arrow-left","geo-arrow-right",
  "geo-arrow-up","geo-check-box","geo-cloud","geo-diamond","geo-ellipse","geo-heart","geo-hexagon",
  "geo-octagon","geo-oval","geo-pentagon","geo-rectangle","geo-rhombus-2","geo-rhombus","geo-star",
  "geo-trapezoid","geo-triangle","geo-x-box","github","group","horizontal-align-end",
  "horizontal-align-middle","horizontal-align-start","info-circle","leading","link","lock","menu",
  "minus","mixed","pack","plus","question-mark-circle","question-mark","redo","reset-zoom",
  "rotate-ccw","rotate-cw","send-backward","send-to-back","share-1","size-extra-large","size-large",
  "size-medium","size-small","spline-cubic","spline-line","stack-horizontal","stack-vertical",
  "status-offline","stretch-horizontal","stretch-vertical","text-align-center","text-align-left",
  "text-align-right","toggle-off","toggle-on","tool-arrow","tool-eraser","tool-frame","tool-hand",
  "tool-highlight","tool-laser","tool-line","tool-media","tool-note","tool-pencil","tool-pointer",
  "tool-screenshot","tool-text","trash","twitter","undo","ungroup","unlock","vertical-align-end",
  "vertical-align-middle","vertical-align-start","warning-triangle","zoom-in","zoom-out",
] as const

const TLDRAW_ASSET_URLS: TLUiAssetUrls = {
  fonts: {
    draw: `${TLDRAW_BASE}/fonts/Shantell_Sans-Tldrawish.woff2`,
    serif: `${TLDRAW_BASE}/fonts/IBMPlexSerif-Medium.woff2`,
    sansSerif: `${TLDRAW_BASE}/fonts/IBMPlexSans-Medium.woff2`,
    monospace: `${TLDRAW_BASE}/fonts/IBMPlexMono-Medium.woff2`,
  },
  icons: Object.fromEntries(
    ALL_ICON_NAMES.map((name) => [name, `${TLDRAW_BASE}/icons/icon/${name}.svg`])
  ),
  translations: Object.fromEntries(
    ["cs","da","de","en","es","fi","fr","hu","it","ja","pl","pt-br","ro","ru","sv","tr","uk","zh-cn","zh-tw"].map(
      (locale) => [locale, `${TLDRAW_BASE}/translations/${locale}.json`]
    )
  ),
  embedIcons: Object.fromEntries(
    ["codepen","codesandbox","excalidraw","figma","observable","replit","spotify","tldraw","vimeo","youtube"].map(
      (type) => [type, `${TLDRAW_BASE}/embed-icons/${type}.png`]
    )
  ),
}

// tldraw's incremental store diff. We only relay the opaque diff between peers
// and hand it straight back to applyDiff/the store listener.
type StoreDiff = RecordsDiff<TLRecord>

interface WhiteboardProps {
  // Full document snapshot (JSON string) to seed the board on mount, or null
  // for a blank board. Captured once on mount — later prop changes are ignored
  // because live updates arrive as incremental diffs via `subscribeRemote`.
  initialSnapshot: string | null
  // Called with an opaque tldraw RecordsDiff whenever the LOCAL user edits the
  // document, so it can be relayed to other peers for live collaboration.
  onChange: (changes: unknown) => void
  // Called (debounced) with a full JSON snapshot so the server can persist the
  // current drawing for mid-session joiners / restarts.
  onSnapshot: (snapshot: string) => void
  // Register a handler for incremental diffs coming FROM other peers. Returns an
  // unsubscribe function.
  subscribeRemote: (fn: (changes: unknown) => void) => () => void
}

/**
 * Shared tldraw canvas. Synchronisation model (mirrors the chat/slide pattern):
 *   • Local edits  -> editor.store.listen({ source: "user" }) -> onChange(diff)
 *   • Remote edits -> subscribeRemote(diff) -> store.applyDiff inside
 *     mergeRemoteChanges() so they are tagged "remote" and never echo back.
 *   • Persistence  -> debounced getSnapshot() -> onSnapshot(json).
 *
 * Rendered only while the board is open and lazy-loaded with ssr:false by the
 * parent, since tldraw is a browser-only, heavy dependency.
 */
export function Whiteboard({ initialSnapshot, onChange, onSnapshot, subscribeRemote }: WhiteboardProps) {
  // Snapshot is only consumed once on mount.
  const initialSnapshotRef = useRef(initialSnapshot)
  // Keep the latest callbacks in refs so onMount never needs to re-run.
  const onChangeRef = useRef(onChange)
  const onSnapshotRef = useRef(onSnapshot)
  const subscribeRef = useRef(subscribeRemote)
  onChangeRef.current = onChange
  onSnapshotRef.current = onSnapshot
  subscribeRef.current = subscribeRemote

  // Teardown collected in onMount, run on unmount.
  const cleanupRef = useRef<(() => void) | null>(null)

  const handleMount = useCallback((editor: Editor) => {
    // Flag to suppress the store listener while we're seeding the initial
    // snapshot. loadSnapshot triggers source:"user" events in tldraw, which
    // would otherwise be mistakenly broadcast to peers as local edits.
    let isLoadingSnapshot = false

    // 2. Relay local edits as incremental diffs + debounced full snapshots.
    //    Registered BEFORE loadSnapshot so the listener is active when remote
    //    diffs arrive later, but gated by isLoadingSnapshot during seeding.
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null
    const unlisten = editor.store.listen(
      (entry) => {
        // Ignore synthetic changes produced by our own loadSnapshot call.
        if (isLoadingSnapshot) return
        onChangeRef.current(entry.changes as StoreDiff)
        if (snapshotTimer) clearTimeout(snapshotTimer)
        snapshotTimer = setTimeout(() => {
          try {
            onSnapshotRef.current(JSON.stringify(getSnapshot(editor.store)))
          } catch (e) {
            console.error("[Replixo] whiteboard: failed to serialize snapshot", e)
          }
        }, 1000)
      },
      { source: "user", scope: "document" },
    )

    // 1. Seed the board with the persisted drawing (document only — we don't
    //    load another user's session/camera state).
    if (initialSnapshotRef.current) {
      try {
        isLoadingSnapshot = true
        const parsed = JSON.parse(initialSnapshotRef.current)
        loadSnapshot(editor.store, parsed.document ? { document: parsed.document } : parsed)
      } catch (e) {
        console.error("[Replixo] whiteboard: failed to load snapshot", e)
      } finally {
        isLoadingSnapshot = false
      }
    }

    // 3. Apply remote peers' diffs. mergeRemoteChanges tags them "remote" so the
    //    user-scoped listener above does not echo them back into the network.
    const unsubscribe = subscribeRef.current((changes) => {
      try {
        editor.store.mergeRemoteChanges(() => {
          editor.store.applyDiff(changes as StoreDiff)
        })
      } catch (e) {
        console.error("[Replixo] whiteboard: failed to apply remote changes", e)
      }
    })

    cleanupRef.current = () => {
      unlisten()
      unsubscribe()
      if (snapshotTimer) clearTimeout(snapshotTimer)
    }
  }, [])

  useEffect(() => {
    return () => {
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [])

  return (
    <div className="absolute inset-0">
      <Tldraw onMount={handleMount} assetUrls={TLDRAW_ASSET_URLS} />
    </div>
  )
}
