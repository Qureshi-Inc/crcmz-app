// Chart building blocks shared by the stats pages (Slap, WhatsApp). Every chart is
// drawn aria-hidden and paired with a real table behind "Show as table".
import type { ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export const n = (v: number | null | undefined) => (v == null ? '–' : v.toLocaleString())
export const hour = (h: number | null | undefined) => (h == null ? '–' : `${String(h).padStart(2, '0')}:00`)

/** A panel's four states: skeleton, error with Retry, empty, content. */
export function Panel<T>({ title, q, empty, wide, children, loadingText, errorText = "Didn't load", action, level = 3 }: {
  title: string; q: UseQueryResult<T>; empty?: (d: T) => string | null; wide?: boolean; loadingText?: string
  errorText?: string; action?: ReactNode; level?: 2 | 3; children: (d: T) => ReactNode
}) {
  const H = level === 2 ? 'h2' : 'h3'
  let body: ReactNode
  if (q.isPending) {
    body = q.fetchStatus === 'idle' || loadingText
      ? <p className="dim stat-wait" role="status">{loadingText ?? 'Waiting…'}</p>
      : <div className="stat-skel" aria-hidden="true"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
  } else if (q.isError && q.data === undefined) {
    body = (
      <div className="stat-err" role="alert">
        <span>{errorText}</span>
        <button type="button" className="btn btn-secondary" onClick={() => void q.refetch()}>Retry</button>
      </div>
    )
  } else {
    const d = q.data as T
    const e = empty?.(d)
    body = e ? <p className="dim stat-empty">{e}</p> : children(d)
  }
  return (
    <article className="glass stat-panel" data-wide={wide || undefined} aria-busy={q.isFetching || undefined}>
      <div className="stat-h-row">
        <H className="stat-h">{title}</H>
        {action}
      </div>
      {body}
    </article>
  )
}

export function Bars({ rows, color, label, head = ['Name', 'Count'], fmt = n }: {
  rows: { name: string; value: number; color?: string }[]; color?: string; label: string; head?: string[]; fmt?: (v: number) => string
}) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <>
      <ol className="hbars" aria-hidden="true">
        {rows.map((r) => (
          <li key={r.name} className="hbar">
            <span className="hbar-name">{r.name}</span>
            <span className="hbar-track"><i style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? color }} /></span>
            <span className="hbar-v num">{fmt(r.value)}</span>
          </li>
        ))}
      </ol>
      <DataTable label={label} head={head} rows={rows.map((r) => [r.name, fmt(r.value)])} />
    </>
  )
}

export function DataTable({ label, head, rows }: { label: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <details className="stat-table">
      <summary>Show as table</summary>
      <table>
        <caption className="sr-only">{label}</caption>
        <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </details>
  )
}

/** A 7×24 day/hour grid (Mon first). `onPick` makes the cells tappable. */
export function HeatGrid({ grid, color, onPick, picked }: {
  grid: number[][]; color?: string; onPick?: (day: number, hour: number) => void; picked?: [number, number] | null
}) {
  const max = Math.max(1, ...grid.flat())
  const alpha = (v: number) => (v <= 0 ? 0 : v / max <= 1 / 3 ? 0.55 : v / max <= 2 / 3 ? 0.75 : 1)
  return (
    <div className="heat" aria-hidden="true" style={color ? { ['--heat' as string]: color } : undefined}>
      {grid.map((row, di) => (
        <div key={di} className="heat-row">
          <span className="heat-day meta">{DAYS[di]}</span>
          {row.map((v, h) => (
            <i
              key={h} style={{ opacity: alpha(v) || undefined }} data-on={v > 0 || undefined} title={`${DAYS[di]} ${hour(h)}: ${v}`}
              data-picked={(picked && picked[0] === di && picked[1] === h) || undefined}
              onClick={onPick ? () => onPick(di, h) : undefined}
            />
          ))}
        </div>
      ))}
      <div className="heat-row heat-hours meta"><span className="heat-day" />{[0, 6, 12, 18].map((h) => <span key={h} style={{ gridColumn: `${h + 2} / span 6` }}>{hour(h)}</span>)}</div>
    </div>
  )
}
