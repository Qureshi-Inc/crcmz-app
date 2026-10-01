// The ⓘ beside a page title: opens that page's section of Help.
import { Link } from 'react-router-dom'
import { DESTS, helpHref, type DestId } from '../app/nav'
import { Icon } from './Icon'

export function HelpLink({ id }: { id: DestId }) {
  const href = helpHref(id)
  if (!href) return null
  const label = `How to use ${DESTS[id].label}`
  return (
    <Link className="help-dot" to={href} aria-label={label} title={label}>
      <Icon name="info" />
    </Link>
  )
}
