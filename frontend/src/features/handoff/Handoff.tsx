// Every destination that is not rebuilt yet renders this: a plain link into the
// classic app, so /app never does less than the dashboard at /.
import { Link, useLocation, useOutletContext } from 'react-router-dom'
import { DESTS, type DestId } from '../../app/nav'
import type { ShellContext } from '../../app/Shell'
import { useTitle } from '../../app/title'
import { HelpLink } from '../../components/HelpLink'

export function Handoff({ id }: { id: DestId }) {
  const d = DESTS[id]
  const { isAdmin, adminKnown } = useOutletContext<ShellContext>()
  const { search } = useLocation()
  useTitle(d.label)

  // PS-11: admin-only is hidden in nav; a direct visit explains instead.
  if (d.adminOnly && !isAdmin) {
    return (
      <div className="page page-reading">
        <h1 className="page-h1" tabIndex={-1}>{d.label}<HelpLink id={d.id} /></h1>
        {adminKnown ? (
          <section className="glass handoff">
            <p className="handoff-lede">Admins only</p>
            <p className="dim">This page is for the squad admin. Everything else is one tap away.</p>
            <Link className="btn btn-secondary" to="/">Back to Squad</Link>
          </section>
        ) : (
          <section className="glass handoff" aria-busy="true"><div className="skeleton" style={{ height: 20, width: '60%' }} /></section>
        )}
      </div>
    )
  }

  // ?upload on Clips keeps its meaning in the classic app.
  const href = id === 'clips' && new URLSearchParams(search).has('upload') ? '/?p=upload' : d.classicHref

  return (
    <div className="page page-reading">
      <h1 className="page-h1" tabIndex={-1}>{d.label}<HelpLink id={d.id} /></h1>
      <section className="glass handoff" aria-labelledby="handoff-lede">
        <p className="handoff-lede" id="handoff-lede">Lives in the classic app for now.</p>
        <p className="dim">{d.blurb} It works there today; the new version is next in line.</p>
        {d.classicHint && <p className="dim">{d.classicHint}</p>}
        <a className="btn btn-primary" href={href}>Open {d.label} in the classic app</a>
      </section>
    </div>
  )
}

export function NotFound() {
  useTitle('Not found')
  return (
    <div className="page page-reading">
      <h1 className="page-h1" tabIndex={-1}>Not here</h1>
      <section className="glass handoff">
        <p className="handoff-lede">Nothing lives at this address.</p>
        <p className="dim">The link may be old, or it has a typo.</p>
        <Link className="btn btn-primary" to="/">Go to Squad</Link>
      </section>
    </div>
  )
}
