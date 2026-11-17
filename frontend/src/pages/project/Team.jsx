import { useEffect, useState } from 'react'
import { Activity, ShieldAlert, UserMinus, UserPlus } from 'lucide-react'
import { api, notifyChanged, onChanged } from '../../api'
import { useConfirm, useToast } from '../../context'
import { useUndoDelete } from '../../components/useUndo'
import { Avatar, Badge, Empty, Field, Modal, PROJECT_ROLES, PROJECT_SECTIONS, PageSkeleton, Spinner, timeAgo, useOpenIssue } from '../../ui'

export function AccessModal({ project, member, onClose, reload }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const [role, setRole] = useState(member.role)
  const [sections, setSections] = useState(member.sections)
  const [busy, setBusy] = useState(false)

  const toggle = (key) => setSections((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]))

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/projects/${project.id}/members/${member.id}`, { method: 'PATCH', body: { role, sections } })
      toast(`Access updated for ${member.full_name}`)
      reload()
      onClose()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }

  return (
    <Modal title={`Access for ${member.full_name}`} onClose={onClose} size="sm">
      <form onSubmit={save}>
        <div className="modal-body">
          <Field label="Role in this project" as="div">
            {PROJECT_ROLES.map((r) => (
              <label className="check-item" key={r.key} style={{ alignItems: 'flex-start' }}>
                <input type="radio" name="role" checked={role === r.key} onChange={() => setRole(r.key)} style={{ marginTop: 3 }} />
                <span><b>{r.label}</b><div className="small muted">{r.hint}</div></span>
              </label>
            ))}
          </Field>
          <Field label="What they can see" as="div" hint="Overview and the member list are always visible.">
            <div className="check-list" style={{ maxHeight: 'none' }}>
              {PROJECT_SECTIONS.map((sec) => (
                <label className="check-item" key={sec.key}>
                  <input type="checkbox" checked={sections.includes(sec.key)} onChange={() => toggle(sec.key)} />
                  <span>{sec.label}</span>
                </label>
              ))}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSections(PROJECT_SECTIONS.map((x) => x.key))}>Select all</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSections([])}>Clear</button>
            </div>
          </Field>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Save access'}</button>
        </div>
      </form>
    </Modal>
  )
}

export function Members({ project, issues, reload }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const confirm = useConfirm()
  const [users, setUsers] = useState([])
  const [selected, setSelected] = useState('')
  const [role, setRole] = useState('contributor')
  const [editing, setEditing] = useState(null)

  useEffect(() => {
    if (project.can_manage) api('/users').then(setUsers).catch(() => {})
  }, [project.can_manage])

  const memberIds = new Set(project.members.map((m) => m.id))
  const candidates = users.filter((u) => !memberIds.has(u.id) && u.is_active !== false)

  const add = async () => {
    if (!selected) return
    try {
      await api(`/projects/${project.id}/members`, { method: 'POST', body: { user_id: Number(selected), role } })
      setSelected('')
      toast('Member added')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const remove = async (m) => {
    const ok = await confirm({
      title: `Remove ${m.full_name}?`,
      message: 'They lose access to this project and their issues become unassigned.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    try {
      await api(`/projects/${project.id}/members/${m.id}`, { method: 'DELETE' })
      toast('Member removed')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const makeOwner = async (m) => {
    const ok = await confirm({
      title: `Make ${m.full_name} the project owner?`,
      message: `${m.full_name} gets full control of this project. ${project.owner ? `${project.owner.full_name} stays on as a contributor.` : ''}`,
      confirmLabel: 'Transfer ownership',
    })
    if (!ok) return
    try {
      await api(`/projects/${project.id}/owner`, { method: 'POST', body: { user_id: m.id } })
      toast(`${m.full_name} is now the owner`)
      reload()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      {project.can_manage ? (
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <select className="select grow" value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="User to add">
            <option value="">{candidates.length ? 'Select a user to add…' : 'Everyone is already a member'}</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{u.full_name} (@{u.username})</option>)}
          </select>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role for the new member">
            {PROJECT_ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          <button className="btn btn-primary" onClick={add} disabled={!selected}><UserPlus size={16} /> Add member</button>
        </div>
      ) : (
        <p className="muted small">Only the project owner or an administrator can add people and change their access.</p>
      )}
      <div className="card">
        {project.members.map((m) => {
          const open = issues.filter((i) => i.assignee?.id === m.id && i.status !== 'done').length
          const isOwner = m.role === 'owner'
          const meta = PROJECT_ROLES.find((r) => r.key === m.role)
          const limited = !isOwner && m.sections.length < PROJECT_SECTIONS.length
          return (
            <div className="list-row" key={m.id} style={{ cursor: 'default' }}>
              <Avatar user={m} size={34} />
              <span className="grow">
                <div style={{ fontWeight: 600 }}>{m.full_name}</div>
                <div className="faint small truncate">
                  @{m.username}
                  {limited && ` · sees ${m.sections.length ? m.sections.map((k) => PROJECT_SECTIONS.find((x) => x.key === k).label.split(' ')[0]).join(', ') : 'Overview only'}`}
                </div>
              </span>
              <span className="muted small hide-mobile">{open} open issue{open === 1 ? '' : 's'}</span>
              {isOwner ? <Badge color="#6366f1" dot={false}>Owner</Badge> : <Badge color={meta.color} dot={false}>{meta.label}{limited ? ' · limited' : ''}</Badge>}
              {project.can_manage && !isOwner && (
                <span className="row" style={{ gap: 2 }}>
                  <button className="btn btn-sm" onClick={() => setEditing(m)}><ShieldAlert size={13} /> Access</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => makeOwner(m)} title="Transfer ownership">Make owner</button>
                  <button className="btn btn-ghost btn-sm btn-icon danger-text" onClick={() => remove(m)} aria-label={`Remove ${m.full_name}`}>
                    <UserMinus size={15} />
                  </button>
                </span>
              )}
            </div>
          )
        })}
      </div>
      <div className="callout">
        <ShieldAlert size={16} />
        <span>
          <b>Owner</b> has full control. <b>Contributors</b> can create and change work. <b>Viewers</b> can only read.
          Use <b>Access</b> to choose which sections each person can see.
        </span>
      </div>
      {editing && <AccessModal project={project} member={editing} onClose={() => setEditing(null)} reload={reload} />}
    </div>
  )
}

/* ───────────── Activity ───────────── */

export function ActivityFeed({ projectId }) {
  const openIssue = useOpenIssue()
  const [rows, setRows] = useState(null)

  useEffect(() => {
    const load = () => api(`/projects/${projectId}/activity`).then(setRows).catch(() => setRows([]))
    load()
    return onChanged(load)
  }, [projectId])

  if (!rows) return <PageSkeleton variant="list" padded={false} />
  if (!rows.length) return <div className="card"><Empty icon={Activity} title="No activity yet" /></div>
  return (
    <div className="card card-pad settings-section">
      <div className="feed">
        {rows.map((a) => (
          <div className="feed-item" key={a.id}>
            <Avatar user={a.user} size={26} />
            <span className="grow">
              <span className="who">{a.user?.full_name || 'Someone'}</span>{' '}
              <span className="muted">{a.message}</span>{' '}
              {a.issue_key && (
                <a href="#" className="issue-key" onClick={(e) => { e.preventDefault(); openIssue(a.issue_id) }}>{a.issue_key}</a>
              )}
            </span>
            <span className="faint small">{timeAgo(a.created_at)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ───────────── Settings ───────────── */
