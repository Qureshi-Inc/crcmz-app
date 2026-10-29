// Where receipts shared from the phone's gallery land (/app/trips/receipts):
//   ?inbox=<id>       the iPhone share extension uploaded them to the server first
//   ?shared=<t1>,<t2> the Android app holds them and serves /__crcmz/shared/<token>
// Pick the trip (skipped when you're on just one), check what was read, add them to
// that trip's Split, then land on it.
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { isImageFile, tripDates, tripsApi, useSplit, useTrips } from '../../lib/trips'
import { errText } from '../tourney/Report'
import { ReceiptBatch } from './ReceiptBatch'
import '../../styles/tourney.css'
import '../../styles/trips.css'

async function sharedFiles(inbox: string, shared: string): Promise<File[]> {
  if (inbox) {
    const r = await tripsApi.inbox(inbox)
    return Promise.all(r.files.map(async (f, i) => {
      const res = await fetch(f.url, { credentials: 'same-origin' })
      if (!res.ok) throw new Error('A shared photo is gone. Share it again.')
      const b = await res.blob()
      return new File([b], `receipt-${i + 1}.jpg`, { type: b.type || f.type || 'image/jpeg' })
    }))
  }
  const tokens = shared.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 30)
  return Promise.all(tokens.map(async (tok, i) => {
    const res = await fetch(`/__crcmz/shared/${encodeURIComponent(tok)}`)
    if (!res.ok) throw new Error('A shared photo is gone. Share it again.')
    const b = await res.blob()
    return new File([b], `receipt-${i + 1}.jpg`, { type: b.type || 'image/jpeg' })
  }))
}

export function ReceiptsPage() {
  useTitle('Receipts')
  const [params] = useSearchParams()
  const inbox = params.get('inbox') || ''
  const shared = params.get('shared') || ''
  const trips = useTrips()
  const nav = useNavigate()
  const [files, setFiles] = useState<File[] | null>(null)
  const [err, setErr] = useState('')
  const [tripId, setTripId] = useState('')

  useEffect(() => {
    if (!inbox && !shared) { setFiles([]); return }
    let live = true
    sharedFiles(inbox, shared)
      .then((fs) => { if (live) setFiles(fs.filter(isImageFile)) })
      .catch((e) => { if (live) setErr(errText(e)) })
    return () => { live = false }
  }, [inbox, shared])

  const list = trips.data?.trips ?? []
  useEffect(() => {
    if (!tripId && list.length === 1) setTripId(list[0]!.id)
  }, [list, tripId])

  return (
    <div className="page tn tr">
      <Link to="/trips" className="btn btn-ghost tn-back"><Icon name="left" className="btn-ico" />Trips</Link>
      <div>
        <h1 className="page-h1" tabIndex={-1}>Receipts</h1>
        <p className="dim tn-sub">{files ? `${files.length} ${files.length === 1 ? 'photo' : 'photos'} shared.` : 'Getting the photos…'} They go into a trip's Split once you've checked them.</p>
      </div>
      {err && <ErrorStrip text={err} onRetry={() => window.location.reload()} />}
      {files && files.length === 0 && !err && (
        <div className="empty glass">
          <p className="empty-title">No photos came through</p>
          <p className="dim">Share receipts from your gallery to CRCMZ, or scan them from a trip's Split.</p>
        </div>
      )}
      {trips.isError && <ErrorStrip text="Couldn't load your trips" onRetry={() => trips.refetch()} />}
      {trips.data && list.length === 0 && (
        <div className="empty glass">
          <p className="empty-title">You're not on a trip</p>
          <p className="dim">Make one (or ask to be invited), then share the receipts again.</p>
          <Link to="/trips" className="btn btn-primary">Trips</Link>
        </div>
      )}
      {files && files.length > 0 && list.length > 1 && (
        <section className="tn-group" aria-labelledby="tr-which">
          <h2 className="eyebrow" id="tr-which">Which trip?</h2>
          <div className="tr-chips tr-chips-wrap" role="group" aria-labelledby="tr-which">
            {list.map((t) => (
              <button key={t.id} type="button" className="chip tr-chip" aria-pressed={tripId === t.id} onClick={() => setTripId(t.id)}>
                {t.name}{tripDates(t) ? <span className="chip-n"> {tripDates(t)}</span> : null}
              </button>
            ))}
          </div>
        </section>
      )}
      {files && files.length > 0 && tripId && <Batch tripId={tripId} files={files} onDone={() => nav(`/trips/${tripId}`)} />}
      {(!files || (trips.isLoading && !trips.data)) && !err && <SkeletonRows n={3} height={88} />}
    </div>
  )
}

function Batch({ tripId, files, onDone }: { tripId: string; files: File[]; onDone: () => void }) {
  const split = useSplit(tripId)
  if (split.isError && !split.data) return <ErrorStrip text="Couldn't load that trip's Split" onRetry={() => split.refetch()} />
  if (!split.data) return <SkeletonRows n={3} height={88} />
  return <ReceiptBatch key={tripId} tripId={tripId} split={split.data} files={files} onDone={onDone} />
}
