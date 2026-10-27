// Where you left a film on this TV: Back out of the player and open it again later, it
// picks up there (unless the party is on it right now: then you join where they are).
import { readLocal, writeLocal } from '../../lib/media'

const KEY = 'tv.resume'
const KEEP = 14 * 86_400_000
type Spot = { t: number; at: number }

export function saveResume(url: string, t: number | null) {
  if (!url || t === null || !Number.isFinite(t) || t < 30) return
  const all = readLocal<Record<string, Spot>>(KEY, {})
  all[url] = { t: Math.max(0, t - 3), at: Date.now() }
  for (const [k, v] of Object.entries(all)) if (Date.now() - v.at > KEEP) delete all[k]
  writeLocal(KEY, all)
}
export function resumeOf(url: string): number {
  const s = readLocal<Record<string, Spot>>(KEY, {})[url]
  return s && Date.now() - s.at < KEEP ? s.t : 0
}
