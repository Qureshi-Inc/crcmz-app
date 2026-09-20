import { useQuery } from '@tanstack/react-query'
import { CACHE } from '@/app/queryClient'
import { api } from '@/lib/api/http'
import { Card, SectionHeading, cx } from '@/components/ui'
import { EmptyState, RelativeTime, SectionError, SkeletonRows, SkeletonTiles } from '@/components/ui/states'
import { PageTitle } from '@/components/PageTitle'

/**
 * Slapshare music.
 *
 * This is the one feature whose data does not come from this backend: the legacy tab
 * fetched thirteen endpoints directly from https://slap.qureshi.io/api/v1/dashboard in a
 * single Promise.all, so one slow or broken widget took the whole tab down and left it
 * permanently stuck (the guard flag was set before the request and never cleared — fixed
 * for the legacy UI in Phase 1).
 *
 * Here the overview loads first and each secondary widget is its own query, so a widget
 * that is unavailable shows its own retry and the rest of the screen still works. Only
 * the widgets that were actually verified against the live service are included; the
 * remaining legacy panels are listed in docs/ux/INVENTORY.md as not yet migrated rather
 * than reimplemented against a shape nobody checked.
 */

const SLAP_BASE = 'https://slap.qureshi.io/api/v1/dashboard'

/** Display names the legacy tab used, kept so the same people are recognisable. */
const NAMES: Record<string, string> = {
  moiz: 'moiz',
  themoosecompany: 'moose',
  shahraiz: 'shahraiz',
  zubair221b: 'zubair',
  nooramin40: 'noor',
  deception: 'deception',
  asamad89: 'asamad',
}
const name = (u: string) => NAMES[u] ?? u

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Cross-origin, and not this app's API — so no credentials and its own timeout. It is a
 * public read endpoint; sending the session cookie to another origin would be wrong even
 * if it were same-site.
 */
function slap<T>(path: string, parse: (raw: unknown) => T) {
  return (signal?: AbortSignal) =>
    api.get<T>(`${SLAP_BASE}${path}`, { signal, timeoutMs: 12_000, parse })
}

interface Stats {
  totalShares: number
  contributors: number
  totalArtists: number
}

const getStats = slap('/stats', (raw): Stats => {
  const s = (raw ?? {}) as Record<string, unknown>
  return {
    totalShares: num(s.total_shares) || num(s.total_songs),
    contributors: num(s.contributors) || num(s.total_users),
    totalArtists: num(s.total_artists),
  }
})

interface LeaderRow {
  user: string
  count: number
}

const getLeaderboard = slap('/leaderboard', (raw): LeaderRow[] => {
  const root = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(root.leaderboard) ? root.leaderboard : Array.isArray(raw) ? raw : []
  return list.flatMap(item => {
    const r = (item ?? {}) as Record<string, unknown>
    const user = str(r.username) ?? str(r.user)
    return user ? [{ user, count: num(r.count) || num(r.shares) }] : []
  })
})

interface RecentRow {
  title: string
  artist: string | null
  user: string | null
  platform: string | null
  at: string | null
}

const getRecent = slap('/recent?limit=30', (raw): RecentRow[] => {
  const root = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(root.recent) ? root.recent : Array.isArray(raw) ? raw : []
  return list.flatMap(item => {
    const r = (item ?? {}) as Record<string, unknown>
    const title = str(r.title) ?? str(r.name)
    if (!title) return []
    return [{
      title,
      artist: str(r.artist),
      user: str(r.username) ?? str(r.user),
      platform: str(r.platform),
      at: str(r.shared_at) ?? str(r.created_at),
    }]
  })
})

const PLATFORM_ICON: Record<string, string> = {
  spotify: '💚',
  apple_music: '🍎',
  youtube: '▶️',
}

export function MusicPage() {
  const stats = useQuery({ queryKey: ['slap', 'stats'], queryFn: ({ signal }) => getStats(signal), ...CACHE.analytics })
  const board = useQuery({ queryKey: ['slap', 'leaderboard'], queryFn: ({ signal }) => getLeaderboard(signal), ...CACHE.analytics })
  const recent = useQuery({ queryKey: ['slap', 'recent'], queryFn: ({ signal }) => getRecent(signal), ...CACHE.analytics })

  // If the service itself is unreachable, every widget will say so individually, which is
  // noise. One message instead, when nothing came back at all.
  const allFailed = stats.isError && board.isError && recent.isError

  return (
    <div className="mx-auto w-full max-w-[var(--content-width)]">
      <PageTitle title="Music" subtitle="What the squad has been sharing." />

      {allFailed ? (
        <SectionError
          error={stats.error}
          what="Slapshare"
          onRetry={() => {
            void stats.refetch()
            void board.refetch()
            void recent.refetch()
          }}
        />
      ) : (
        <>
          <section aria-labelledby="slap-overview" className="mb-7">
            <SectionHeading level={2}>
              <span id="slap-overview">Overview</span>
            </SectionHeading>
            {stats.isPending && !stats.data ? (
              <SkeletonTiles count={3} />
            ) : stats.isError && !stats.data ? (
              <SectionError error={stats.error} what="the overview" onRetry={() => void stats.refetch()} />
            ) : (
              <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
                <Tile label="Shares" value={String(stats.data?.totalShares ?? 0)} />
                <Tile label="Contributors" value={String(stats.data?.contributors ?? 0)} />
                <Tile label="Artists" value={String(stats.data?.totalArtists ?? 0)} />
              </div>
            )}
          </section>

          <section aria-labelledby="slap-board" className="mb-7">
            <SectionHeading level={2}>
              <span id="slap-board">Who shares most</span>
            </SectionHeading>
            {board.isPending && !board.data ? (
              <SkeletonRows rows={4} />
            ) : board.isError && !board.data ? (
              <SectionError error={board.error} what="the leaderboard" onRetry={() => void board.refetch()} />
            ) : (board.data ?? []).length === 0 ? (
              <Card>
                <EmptyState title="Nobody has shared anything yet" />
              </Card>
            ) : (
              <Leaderboard rows={board.data ?? []} />
            )}
          </section>

          <section aria-labelledby="slap-recent">
            <SectionHeading level={2}>
              <span id="slap-recent">Recently shared</span>
            </SectionHeading>
            {recent.isPending && !recent.data ? (
              <SkeletonRows rows={6} />
            ) : recent.isError && !recent.data ? (
              <SectionError error={recent.error} what="recent shares" onRetry={() => void recent.refetch()} />
            ) : (recent.data ?? []).length === 0 ? (
              <Card>
                <EmptyState title="Nothing shared recently" />
              </Card>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {(recent.data ?? []).map((r, i) => (
                  <Card as="li" key={`${r.title}-${i}`} className="flex items-center gap-3 px-3.5 py-2.5">
                    <span aria-hidden="true" className="text-lg">
                      {(r.platform && PLATFORM_ICON[r.platform]) ?? '🎵'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{r.title}</p>
                      <p className="truncate text-xs text-[var(--color-fg-subtle)]">
                        {r.artist}
                        {r.user && <> · {name(r.user)}</>}
                      </p>
                    </div>
                    {r.at && (
                      <span className="shrink-0 text-xs text-[var(--color-fg-subtle)]">
                        <RelativeTime at={r.at} />
                      </span>
                    )}
                  </Card>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Leaderboard({ rows }: { rows: LeaderRow[] }) {
  const max = Math.max(...rows.map(r => r.count), 1)
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r, i) => (
        <Card as="li" key={r.user} className="flex items-center gap-3 px-3.5 py-2.5">
          <span className="w-5 shrink-0 text-center text-sm text-[var(--color-fg-subtle)]">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{name(r.user)}</p>
            <span
              aria-hidden="true"
              className={cx('mt-1 block h-1 rounded-[var(--radius-full)] bg-[var(--color-accent)]')}
              style={{ width: `${Math.round((r.count / max) * 100)}%` }}
            />
          </div>
          <span className="numeral shrink-0 text-sm text-[var(--color-accent-text)]">
            {r.count}
          </span>
        </Card>
      ))}
    </ul>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <Card className="px-4 py-3.5 text-center">
      <p className="numeral text-2xl">{value}</p>
      <p className="mt-0.5 text-2xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {label}
      </p>
    </Card>
  )
}
