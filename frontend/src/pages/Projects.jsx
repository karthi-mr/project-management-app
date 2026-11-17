import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CalendarDays, FolderKanban, Plus, Search } from 'lucide-react'
import { api, notifyChanged, onChanged } from '../api'
import { useAuth, useToast } from '../context'
import {
  Avatar,
  AvatarStack,
  Empty,
  Field,
  Modal,
  PHASES,
  PROJECT_COLORS,
  PageSkeleton,
  ProjectIcon,
  PROJECT_STATUSES,
  Progress,
  ProjectStatusBadge,
  Spinner,
  formatDate,
  isOverdue,
} from '../ui'
import SignoffModePicker from '../components/SignoffModePicker'

function suggestKey(name) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean)
  if (!words.length) return ''
  const key = words.length === 1 ? words[0].slice(0, 4) : words.map((w) => w[0]).join('').slice(0, 5)
  return /^[A-Z]/.test(key) ? key : `P${key}`.slice(0, 5)
}

export function ProjectFormFields({ form, setForm }) {
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }))
  return (
    <>
      <Field label="Description">
        <textarea className="textarea" value={form.description} onChange={set('description')} placeholder="What is this project about?" />
      </Field>
      <div className="form-grid">
        <Field label="Status">
          <select className="select" value={form.status} onChange={set('status')}>
            {PROJECT_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </Field>
        <Field label="Lifecycle phase">
          <select className="select" value={form.phase} onChange={set('phase')}>
            {PHASES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </Field>
        <Field label="Start date">
          <input className="input" type="date" value={form.start_date} onChange={set('start_date')} />
        </Field>
        <Field label="Due date">
          <input className="input" type="date" value={form.due_date} min={form.start_date || undefined} onChange={set('due_date')} />
        </Field>
        <Field label="Color" as="div">
          <div className="swatches" style={{ paddingTop: 6 }}>
            {PROJECT_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className={`swatch ${form.color === c ? 'active' : ''}`}
                style={{ background: c, color: c }}
                onClick={() => setForm((f) => ({ ...f, color: c }))}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        </Field>
      </div>
    </>
  )
}

function NewProjectModal({ onClose }) {
  const { user } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const [users, setUsers] = useState([])
  const [templates, setTemplates] = useState([])
  const [keyTouched, setKeyTouched] = useState(false)
  const [form, setForm] = useState({
    name: '', key: '', description: '', status: 'active', phase: 'planning', color: PROJECT_COLORS[0],
    start_date: '', due_date: '', member_ids: [], template_id: '', signoff_mode: 'simple',
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api('/users').then((rows) => setUsers(rows.filter((u) => u.id !== user.id && u.is_active !== false))).catch(() => {})
    api('/templates').then(setTemplates).catch(() => {})
  }, [user.id])

  const toggleMember = (id) =>
    setForm((f) => ({
      ...f,
      member_ids: f.member_ids.includes(id) ? f.member_ids.filter((x) => x !== id) : [...f.member_ids, id],
    }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const project = await api('/projects', {
        method: 'POST',
        body: {
          ...form,
          start_date: form.start_date || null,
          due_date: form.due_date || null,
          template_id: form.template_id ? Number(form.template_id) : null,
        },
      })
      toast(`Project ${project.name} created`)
      notifyChanged()
      navigate(`/projects/${project.id}`)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 130px' }}>
            <Field label="Name">
              <input
                className="input"
                value={form.name}
                maxLength={120}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value, key: keyTouched ? f.key : suggestKey(e.target.value) }))}
                placeholder="Website redesign"
                autoFocus
                required
              />
            </Field>
            <Field label="Key" hint="Prefix for issue IDs">
              <input
                className="input mono"
                value={form.key}
                maxLength={10}
                onChange={(e) => {
                  setKeyTouched(true)
                  setForm((f) => ({ ...f, key: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') }))
                }}
                placeholder="WEB"
                required
              />
            </Field>
          </div>
          {templates.length > 0 && (
            <Field
              label="Start from"
              hint={(() => {
                const t = templates.find((x) => x.id === Number(form.template_id))
                if (!t) return 'A blank project still gets the suggested phase checklists.'
                const s = t.summary
                return `Adds ${s.features} features, ${s.milestones} milestones, ${s.documents} documents, ${s.risks} risks and ${s.phase_checks} checklist items. Milestone dates are set from the start date.`
              })()}
            >
              <select className="select" value={form.template_id} onChange={(e) => setForm((f) => ({ ...f, template_id: e.target.value }))}>
                <option value="">Blank project</option>
                {templates.map((t) => <option key={t.id} value={t.id}>Template: {t.name}</option>)}
              </select>
            </Field>
          )}
          <ProjectFormFields form={form} setForm={setForm} />
          <Field label="Stage sign-off for features and milestones" hint="You can change this later in the project's settings." as="div">
            <SignoffModePicker value={form.signoff_mode} onChange={(signoff_mode) => setForm((f) => ({ ...f, signoff_mode }))} strictLocked={!user?.org?.features?.includes('approvals_advanced')} />
          </Field>
          {users.length > 0 && (
            <Field label="Team members" hint="You are added automatically as the owner." as="div">
              <div className="check-list">
                {users.map((u) => (
                  <label className="check-item" key={u.id}>
                    <input type="checkbox" checked={form.member_ids.includes(u.id)} onChange={() => toggleMember(u.id)} />
                    <Avatar user={u} size={24} />
                    <span>{u.full_name}</span>
                    <span className="faint small">@{u.username}</span>
                  </label>
                ))}
              </div>
            </Field>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim() || form.key.length < 2}>
            {busy ? <Spinner /> : 'Create project'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default function Projects() {
  const { user } = useAuth()
  const canCreate = user.role === 'admin' || user.role === 'manager'
  const [owner, setOwner] = useState('')
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('current')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    const load = () => api('/projects').then(setProjects).catch((e) => setError(e.message))
    load()
    return onChanged(load)
  }, [])

  if (error) return <div className="page"><div className="form-error">{error}</div></div>
  if (!projects) return <PageSkeleton variant="cards" />

  const term = query.trim().toLowerCase()
  const filtered = projects.filter((p) => {
    if (status === 'current' && p.status === 'archived') return false
    if (status !== 'current' && status !== 'all' && p.status !== status) return false
    if (owner && String(p.owner?.id ?? 'none') !== owner) return false
    return !term || p.name.toLowerCase().includes(term) || p.key.toLowerCase().includes(term)
  })

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p>{projects.length} project{projects.length === 1 ? '' : 's'} you can access.</p>
        </div>
        {canCreate && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New project
          </button>
        )}
      </div>

      {projects.length > 0 && (
        <div className="toolbar">
          <div className="input-icon">
            <Search size={15} />
            <input className="input search-input" placeholder="Filter projects…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
            <option value="current">All except archived</option>
            <option value="all">All statuses</option>
            {PROJECT_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          {user.role === 'admin' && (
            <select className="select" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner filter">
              <option value="">All owners</option>
              {[...new Map(projects.filter((p) => p.owner).map((p) => [p.owner.id, p.owner])).values()]
                .sort((a, b) => a.full_name.localeCompare(b.full_name))
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.full_name} ({projects.filter((p) => p.owner?.id === o.id).length})
                  </option>
                ))}
              {projects.some((p) => !p.owner) && <option value="none">No owner</option>}
            </select>
          )}
        </div>
      )}

      {projects.length === 0 ? (
        <div className="card">
          <Empty
            icon={FolderKanban}
            title="Create your first project"
            action={canCreate && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> New project</button>}
          >
            {canCreate
              ? 'Projects hold your features, issues, milestones and team. Start one to begin tracking work.'
              : 'You have not been added to any project yet. A project owner or administrator can add you.'}
          </Empty>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card"><Empty icon={Search} title="No projects match">Try a different search or status filter.</Empty></div>
      ) : (
        <div className="grid grid-cards">
          {filtered.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="card project-card">
              <div className="row">
                <ProjectIcon project={p} />
                <span className="grow">
                  <h3 className="truncate">{p.name}</h3>
                  <span className="faint small">{p.key}</span>
                </span>
                <ProjectStatusBadge status={p.status} />
              </div>
              <p className="project-desc">{p.description || 'No description yet.'}</p>
              <div>
                <div className="row between small muted" style={{ marginBottom: 6 }}>
                  <span>{p.done_count} of {p.issue_count} issues done</span>
                  <b>{p.progress}%</b>
                </div>
                <Progress value={p.progress} color={p.color} />
              </div>
              <div className="small muted truncate">
                Owner: <b style={{ color: 'var(--text)' }}>{p.owner?.full_name || 'None'}</b>
                {p.my_role && p.my_role !== 'owner' && p.my_role !== 'admin' && <> · you are a {p.my_role}</>}
              </div>
              <div className="row between">
                <AvatarStack users={p.members} />
                {p.due_date && (
                  <span className={`due ${isOverdue(p.due_date, p.status === 'completed') ? 'overdue' : ''}`}>
                    <CalendarDays size={12} /> {formatDate(p.due_date)}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </div>
  )
}
