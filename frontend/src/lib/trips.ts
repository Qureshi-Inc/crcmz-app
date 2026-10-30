// Trips: plan a trip with the squad, split its costs and post its moments. Only the
// people invited to a trip can see it (the server answers 404 to anyone else). The
// Calgary trip is the trip.crcmz.me one (`linked`): its Split and Moments are that
// site's own, read and written through the server.
import { useQuery } from '@tanstack/react-query'
import { ApiError, NetworkError, getJSON, request } from './http'
import { markSignedOut } from './session'

export type TripMember = { sub: string; name: string }
export type Trip = {
  id: string; name: string; place: string; start: string; end: string; currency: string
  linked: boolean; site_url: string | null; created_by: string; can_manage: boolean; members: TripMember[]
}
export type SplitPerson = { key: string; name: string }
export type Expense = {
  id: string; payer: string; desc: string; cents: number; currency: string; orig_cents: number
  shares: Record<string, number>; receipt_url: string | null; added_by_name: string; added_at: string; can_delete: boolean
}
export type Settlement = { id: string; from: string; to: string; cents: number; added_at: string }
export type Split = {
  currency: string; currencies: string[]; fx: Record<string, number>; people: SplitPerson[]; me: string | null
  expenses: Expense[]; settlements: Settlement[]; balances: Record<string, number>
  settle: { from: string; to: string; cents: number }[]; total_cents: number
}
export type Reading = {
  ok: boolean; cents: number; currency: string | null; other_currency: string | null
  merchant: string; summary: string; date: string; confidence: number | null
}
export type MomentPhoto = { name: string; kind: 'image' | 'video'; thumb: string; url: string }
export type Moment = { id: string; by: string; text: string; at: string; photos: MomentPhoto[]; likes: number; liked: boolean; mine: boolean }
export type Reel = { status: 'none' | 'building' | 'ready' | 'failed'; url?: string | null; slides?: number; moments?: number; seconds?: number; error?: string }
export type Moments = { moments: Moment[]; reel: Reel | null }

const T = '/api/trips'

export const useTrips = () => useQuery({
  queryKey: ['trips', 'list'], refetchInterval: 60_000,
  queryFn: ({ signal }) => getJSON<{ trips: Trip[]; can_link: boolean }>(T, signal),
})
export const useTripPeople = (enabled = true) => useQuery({
  queryKey: ['trips', 'people'], staleTime: 5 * 60_000, enabled,
  queryFn: ({ signal }) => getJSON<{ people: TripMember[] }>(`${T}/people`, signal),
})
export const useSplit = (id: string) => useQuery({
  queryKey: ['trips', 'split', id], refetchInterval: 30_000, enabled: Boolean(id),
  queryFn: ({ signal }) => getJSON<Split>(`${T}/${encodeURIComponent(id)}/split`, signal),
})
export const useMoments = (id: string, enabled = true) => useQuery<Moments>({
  queryKey: ['trips', 'moments', id], enabled: Boolean(id) && enabled,
  refetchInterval: (q) => (q.state.data?.reel?.status === 'building' ? 5_000 : 60_000),
  queryFn: ({ signal }) => getJSON<Moments>(`${T}/${encodeURIComponent(id)}/moments`, signal),
})

/** A multipart POST through the same errors as request(): ApiError for a non-2xx, NetworkError in transit. */
async function form<R>(url: string, fd: FormData, timeoutMs = 120_000): Promise<R> {
  const ctrl = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', body: fd, credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: ctrl.signal })
  } catch (e) {
    throw new NetworkError(timedOut ? 'timed out' : (e as Error)?.message || 'network error', timedOut)
  } finally {
    window.clearTimeout(timer)
  }
  let body: { error?: unknown; detail?: unknown } & Record<string, unknown> = {}
  try { body = await res.json() } catch { /* empty or not JSON */ }
  if (!res.ok) {
    if (res.status === 401) markSignedOut()
    const d = body.error ?? body.detail
    throw new ApiError(res.status, typeof d === 'string' ? d : '', null)
  }
  return body as R
}

const id = (s: string) => encodeURIComponent(s)
export type TripPeople = { linked: boolean; people: string[]; can_manage: boolean }
export const useTripSplitPeople = (tripId: string, enabled = true) => useQuery<TripPeople>({
  queryKey: ['trips', 'people', tripId], enabled: Boolean(tripId) && enabled, staleTime: 30_000,
  queryFn: ({ signal }) => getJSON<TripPeople>(`${T}/${encodeURIComponent(tripId)}/people`, signal),
})
export const tripsApi = {
  create: (b: { name: string; place?: string; start?: string; end?: string; currency?: string; members: string[]; link?: boolean }) =>
    request<Trip>(T, { method: 'POST', body: b }),
  update: (tid: string, b: Partial<{ name: string; place: string; start: string; end: string; members: string[] }>) =>
    request<Trip>(`${T}/${id(tid)}`, { method: 'PATCH', body: b }),
  remove: (tid: string) => request<{ ok: boolean }>(`${T}/${id(tid)}`, { method: 'DELETE' }),
  setPeople: (tid: string, people: string[]) =>
    request<{ ok: boolean; people: string[] }>(`${T}/${id(tid)}/people`, { method: 'PUT', body: { people } }),
  addExpense: (tid: string, b: { payer: string; desc: string; currency: string; orig_cents: number; parts: string[]; receipt?: string }) =>
    request<{ ok: boolean; expense: Expense }>(`${T}/${id(tid)}/expenses`, { method: 'POST', body: b, timeoutMs: 30_000 }),
  removeExpense: (tid: string, eid: string) => request<{ ok: boolean }>(`${T}/${id(tid)}/expenses/${id(eid)}`, { method: 'DELETE' }),
  settle: (tid: string, b: { from: string; to: string; cents: number }) =>
    request<{ ok: boolean }>(`${T}/${id(tid)}/settlements`, { method: 'POST', body: b }),
  receipt: (tid: string, blob: Blob) => {
    const fd = new FormData(); fd.append('receipt', blob, 'receipt.jpg')
    return form<{ receipt: string }>(`${T}/${id(tid)}/receipts`, fd, 60_000)
  },
  scan: (blob: Blob) => {
    const fd = new FormData(); fd.append('receipt', blob, 'receipt.jpg')
    return form<Reading>(`${T}/receipts/scan`, fd, 150_000)
  },
  postMoment: (tid: string, text: string, photos: File[]) => {
    const fd = new FormData(); fd.append('text', text)
    photos.forEach((p) => fd.append('photos', p, p.name || 'photo.jpg'))
    return form<{ ok: boolean; moment: Moment }>(`${T}/${id(tid)}/moments`, fd, 180_000)
  },
  like: (tid: string, mid: string) => request<{ likes: number; liked: boolean }>(`${T}/${id(tid)}/moments/${id(mid)}/like`, { method: 'POST', body: {} }),
  removeMoment: (tid: string, mid: string) => request<{ ok: boolean }>(`${T}/${id(tid)}/moments/${id(mid)}`, { method: 'DELETE' }),
  inbox: (iid: string) => getJSON<{ files: { n: number; url: string; type: string }[] }>(`${T}/inbox/${id(iid)}`),
}

/** A photo made small for upload and the AI: ≤ `max` px on its long side, JPEG. */
export async function shrinkImage(file: Blob, max = 1400): Promise<{ blob: Blob; url: string }> {
  const src = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = () => bad(new Error("That photo couldn't be opened here. Try a JPEG."))
      i.src = src
    })
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    const blob = await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("That photo couldn't be opened."))), 'image/jpeg', 0.82))
    return { blob, url: URL.createObjectURL(blob) }
  } finally {
    URL.revokeObjectURL(src)
  }
}

export const isImageFile = (f: File) => /^image\//.test(f.type || '') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name || '')

/** "$12.50", "US$9.00": in the trip's own words for money. */
export function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency, currencyDisplay: currency === 'CAD' ? 'narrowSymbol' : 'symbol' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

/** "Oct 29 – Nov 1", "Oct 29", or "" with no dates. */
export function tripDates(t: { start: string; end: string }): string {
  const f = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
  if (t.start && t.end && t.start !== t.end) return `${f(t.start)} – ${f(t.end)}`
  if (t.start || t.end) return f(t.start || t.end)
  return ''
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })
}

export const initial = (name: string) => (name || '?').trim().charAt(0).toUpperCase() || '?'

/** Typing money like a register: digits fill from the cents. */
export const parseCents = (v: string) => Math.min(99_999_999, Number.parseInt(v.replace(/\D/g, '') || '0', 10))
export const centsText = (c: number) => (c ? `${Math.floor(c / 100).toLocaleString('en-CA')}.${String(c % 100).padStart(2, '0')}` : '')
