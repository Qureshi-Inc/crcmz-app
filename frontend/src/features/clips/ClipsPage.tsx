// PS-2 · Clips: the month at a glance, my reels, uploads and the full catalogue.
// The Studio editor and the upload flow still live in the classic app (handoff).
import { useEffect } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'
import * as Tabs from '@radix-ui/react-tabs'
import type { ShellContext } from '../../app/Shell'
import { useTitle } from '../../app/title'
import { usePipelineStatus } from '../../lib/clips'
import { Catalogue } from './Catalogue'
import { Overview, UPLOAD_HREF, useCountdown } from './Overview'

export function ClipsPage() {
  useTitle('Clips')
  const [params, setParams] = useSearchParams()
  const upload = params.has('upload')
  useEffect(() => { if (upload) window.location.replace(UPLOAD_HREF) }, [upload])
  const { isAdmin } = useOutletContext<ShellContext>()
  const status = usePipelineStatus()
  const view = params.get('view') === 'all' ? 'all' : 'overview'

  function setView(v: string) {
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (v === 'all') n.set('view', 'all')
      else { n.delete('view'); n.delete('month'); n.delete('sender'); n.delete('status') }
      return n
    }, { replace: true })
  }

  if (upload) return null
  return (
    <div className="page">
      <div className="clips-head">
        <div>
          <h1 className="page-h1" tabIndex={-1}>Clips</h1>
          <SummaryBar q={status} />
        </div>
        <a className="btn btn-primary" href={UPLOAD_HREF}>📤 Send a video</a>
      </div>
      <Tabs.Root value={view} onValueChange={setView} className="clips-tabs">
        <Tabs.List className="seg clips-seg" aria-label="Clips view">
          <Tabs.Trigger value="overview" className="seg-tab">Overview</Tabs.Trigger>
          <Tabs.Trigger value="all" className="seg-tab">All clips</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="overview"><Overview status={status} /></Tabs.Content>
        <Tabs.Content value="all"><Catalogue isAdmin={isAdmin} /></Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

function SummaryBar({ q }: { q: ReturnType<typeof usePipelineStatus> }) {
  const s = q.data
  const left = useCountdown(s?.next_build_ts)
  const monthName = new Date().toLocaleDateString(undefined, { month: 'long' })
  return (
    <p className="clips-summary" aria-live="polite">
      {s ? (
        <>📅 {monthName} · <b className="num">{s.clips_this_month}</b> clips{left && <> · build in <b className="gold num">{left}</b></>}</>
      ) : ' '}
    </p>
  )
}
