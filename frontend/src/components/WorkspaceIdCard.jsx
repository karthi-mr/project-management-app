import { Building2, Copy, Link2 } from 'lucide-react'
import { useAuth, useToast } from '../context'
import { signInLink } from '../workspaceId'

/** The workspace ID people need to sign in, with buttons to copy it or a ready-made sign-in link. */
export default function WorkspaceIdCard({ admin = false }) {
  const { user } = useAuth()
  const toast = useToast()
  const org = user?.org
  if (!org?.public_id) return null
  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text)
      toast(`${what} copied`)
    } catch {
      toast(`Could not copy the ${what.toLowerCase()}`, 'error')
    }
  }
  return (
    <div className="card card-pad stack">
      <h2 className="icon-label"><Building2 size={17} /> <span>Workspace ID</span></h2>
      <div className="row between row-wrap" style={{ gap: 12 }}>
        <div>
          <div className="workspace-id" data-testid="workspace-id">{org.public_id}</div>
          <div className="small muted">{org.name}</div>
        </div>
        <div className="row row-wrap" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm" onClick={() => copy(org.public_id, 'Workspace ID')}><Copy size={14} /> Copy ID</button>
          <button type="button" className="btn btn-sm" onClick={() => copy(signInLink(org), 'Sign-in link')}><Link2 size={14} /> Copy sign-in link</button>
        </div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {admin
          ? 'Everyone in this workspace signs in with this ID plus their own username and password. Share the sign-in link with new people: it fills the ID in for them.'
          : 'You sign in with this ID plus your username and password. This device remembers it; on a new device, use the sign-in link or type the ID.'}
      </p>
    </div>
  )
}
