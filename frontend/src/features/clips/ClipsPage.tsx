// PS-2 · Clips: the month at a glance, my reels, uploads and the full catalogue.
// `?upload` opens Send a video: a bottom sheet on a phone, the inline card on desktop.
import { useOutletContext, useSearchParams } from 'react-router-dom'
import * as Tabs from '@radix-ui/react-tabs'
import type { ShellContext } from '../../app/Shell'
import { useTitle } from '../../app/title'
import { usePipelineStatus } from '../../lib/clips'
import { useDesktop } from '../../lib/media'
import { pillText, useUpload } from '../../lib/upload'
import { Catalogue } from './Catalogue'
import { Overview, useCountdown } from './Overview'
import { UploadSheet, useUploadRefresh } from './SendVideo'

export function ClipsPage() {
  useTitle('Clips')
  const [params, setParams] = useSearchParams()
  const upload = params.has('upload')
  const desktop = useDesktop()
  const { isAdmin } = useOutletContext<ShellContext>()
  const status = usePipelineStatus()
  const view = params.get('view') === 'all' && !(upload && desktop) ? 'all' : 'overview'
  const up = useUpload()
  const pill = pillText(up)
  useUploadRefresh()

  function setUpload(on: boolean) {
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (on) { n.set('upload', ''); if (desktop) n.delete('view') } else n.delete('upload')
      return n
    }, { replace: !on })
  }

  function setView(v: string) {
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (v === 'all') n.set('view', 'all')
      else { n.delete('view'); n.delete('month'); n.delete('sender'); n.delete('status') }
      return n
    }, { replace: true })
  }

  return (
    <div className="page">
      <div className="clips-head">
        <div>
          <h1 className="page-h1" tabIndex={-1}>Clips</h1>
          <SummaryBar q={status} />
        </div>
        <div className="clips-cta">
          {pill && (
            <button type="button" className="upload-pill" data-kind={up.kind} onClick={() => setUpload(true)} aria-live="polite">
              {pill}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => setUpload(true)}>📤 Send a video</button>
        </div>
      </div>
      <Tabs.Root value={view} onValueChange={setView} className="clips-tabs">
        <Tabs.List className="seg clips-seg" aria-label="Clips view">
          <Tabs.Trigger value="overview" className="seg-tab">Overview</Tabs.Trigger>
          <Tabs.Trigger value="all" className="seg-tab">All clips</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="overview"><Overview status={status} focusUpload={upload && desktop} onFocused={() => setUpload(false)} onSendVideo={() => setUpload(true)} /></Tabs.Content>
        <Tabs.Content value="all"><Catalogue isAdmin={isAdmin} /></Tabs.Content>
      </Tabs.Root>
      {!desktop && <UploadSheet open={upload} onOpenChange={(v) => setUpload(v)} />}
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
