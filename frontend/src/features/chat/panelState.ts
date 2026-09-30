// Desktop Chat Board panel: expanded (360 px) or collapsed to a 60 px rail (CB-08).
// Persisted per device, like the classic board's collapse.
import { useSyncExternalStore } from 'react'
import { readLocal, writeLocal } from '../../lib/media'

const KEY = 'crcmz_app_board_collapsed'
let collapsed = readLocal<boolean>(KEY, false)
const listeners = new Set<() => void>()

export function setPanelCollapsed(v: boolean) {
  collapsed = v
  writeLocal(KEY, v)
  listeners.forEach((l) => l())
}
export function usePanelCollapsed(): boolean {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => collapsed)
}
