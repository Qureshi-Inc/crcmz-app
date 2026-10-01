// The phone tab bar's three slots: the user's own pick, saved on this device.
import { useSyncExternalStore } from 'react'
import { readLocal, writeLocal } from '../lib/media'
import { DEFAULT_TABS, TAB_CHOICES, type DestId } from './nav'

const KEY = 'crcmz_app_tabs'

/** Three different slot choices, or the default: a stale or hand-edited value never breaks the bar. */
function valid(v: unknown): DestId[] {
  if (!Array.isArray(v) || v.length !== 3) return DEFAULT_TABS
  if (!v.every((id) => TAB_CHOICES.includes(id as DestId)) || new Set(v).size !== 3) return DEFAULT_TABS
  return v as DestId[]
}

let tabs = valid(readLocal(KEY, null))
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

function onStorage(e: StorageEvent) {
  if (e.key !== KEY) return
  tabs = valid(readLocal(KEY, null))
  emit()
}

export function useTabs(): DestId[] {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      if (subs.size === 1) window.addEventListener('storage', onStorage)
      return () => {
        subs.delete(cb)
        if (!subs.size) window.removeEventListener('storage', onStorage)
      }
    },
    () => tabs,
  )
}

/** Put `id` in `slot`. If it's already in another slot, the two swap, so all three stay different. */
export function setTab(slot: number, id: DestId) {
  const next = [...tabs]
  const was = next.indexOf(id)
  if (was === slot) return
  if (was >= 0) next[was] = next[slot]!
  next[slot] = id
  tabs = valid(next)
  writeLocal(KEY, tabs)
  emit()
}

export function resetTabs() {
  tabs = DEFAULT_TABS
  writeLocal(KEY, tabs)
  emit()
}

export const isDefaultTabs = (t: DestId[]) => t.every((id, i) => id === DEFAULT_TABS[i])
