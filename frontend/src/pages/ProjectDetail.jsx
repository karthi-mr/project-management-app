import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  FlaskConical,
  Activity,
  BarChart3,
  Bookmark,
  CalendarDays,
  ChevronLeft,
  Columns3,
  FileText,
  Flag,
  GanttChart,
  Layers,
  LayoutDashboard,
  List,
  ListChecks,
  MessageSquare,
  Pencil,
  Plus,
  Repeat,
  Rocket,
  Search,
  Settings,
  ShieldAlert,
  Stamp,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  Zap,
} from 'lucide-react'
import { api, notifyChanged, onChanged } from '../api'
import { useConfirm, useToast } from '../context'
import { useUndoDelete } from '../components/useUndo'
import {
  MILESTONE_STAGES,
  FEATURE_STAGES,
  byKey,
  Avatar,
  AvatarStack,
  Badge,
  Empty,
  Field,
  Modal,
  PRIORITIES,
  PROJECT_ROLES,
  PROJECT_SECTIONS,
  PriorityIcon,
  Progress,
  ProjectStatusBadge,
  PageSkeleton,
  ProjectIcon,
  statusesOf,
  SortHeader,
  Spinner,
  StatusBadge,
  TYPES,
  TypeIcon,
  formatDate,
  isOverdue,
  timeAgo,
  useOpenIssue,
} from '../ui'
import IssueForm from '../components/IssueForm'
import { ProjectFormFields } from './Projects'
import { Overview, ProjectTimeline } from './ProjectPlanning'
import { FeatureModal, Features, Releases } from './ProjectFeatures'
import { Documents, Reports, Risks } from './ProjectExtras'
import { FieldsCard, LogoCard, WorkflowCard } from '../components/ProjectSetup'
import { Approvals, AutomationsCard, IssueTemplatesCard, StageSignoff } from '../components/ProjectRules'
import Sprints from './Sprints'
import { PlanGate } from '../components/License'
import { ClientFeedbackCard, ShareLinksCard, SignoffCard } from '../components/ProjectSharing'
import Tests from './Tests'

const TABS = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'features', label: 'Features', icon: Layers },
  { key: 'board', label: 'Board', icon: Columns3 },
  { key: 'list', label: 'List', icon: List },
  { key: 'timeline', label: 'Timeline', icon: GanttChart },
  { key: 'milestones', label: 'Milestones', icon: Flag },
  { key: 'sprints', label: 'Sprints', icon: Zap },
  { key: 'tests', label: 'Tests', icon: FlaskConical },
  { key: 'releases', label: 'Releases', icon: Rocket },
  { key: 'approvals', label: 'Approvals', icon: Stamp },
  { key: 'risks', label: 'Risks', icon: ShieldAlert },
  { key: 'docs', label: 'Docs', icon: FileText },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
  { key: 'members', label: 'Members', icon: Users },
  { key: 'activity', label: 'Activity', icon: Activity },
  { key: 'settings', label: 'Settings', icon: Settings },
]

// Tabs are grouped so a project with every section enabled stays easy to scan.
const TAB_GROUPS = [
  { key: 'plan', label: 'Plan', tabs: ['overview', 'features', 'milestones', 'timeline'] },
  { key: 'work', label: 'Work', tabs: ['board', 'list', 'sprints', 'tests', 'docs'] },
  { key: 'deliver', label: 'Deliver', tabs: ['releases', 'approvals', 'risks', 'reports'] },
  { key: 'team', label: 'Team', tabs: ['members', 'activity', 'settings'] },
]

// Which permission each tab needs (tabs not listed are always shown).
const TAB_SECTION = {
  tests: 'features',
  features: 'features', board: 'issues', list: 'issues', timeline: 'issues', sprints: 'issues', milestones: 'milestones',
  releases: 'releases', risks: 'risks', docs: 'docs', reports: 'reports', activity: 'activity',
}

function tabsFor(project) {
  if (!project) return TABS
  return TABS.filter((t) => {
    if (t.key === 'settings') return project.can_manage
    if (t.key === 'reports') return project.sections.includes('reports') && project.sections.includes('issues')
    return !TAB_SECTION[t.key] || project.sections.includes(TAB_SECTION[t.key])
  })
}

/* ───────────── Filters ───────────── */

const EMPTY_FILTERS = { q: '', assignee: '', priority: '', type: '', status: '', feature: '' }

function applyFilters(issues, f) {
  const term = f.q.trim().toLowerCase()
  return issues.filter((i) => {
    if (term && !(`${i.key} ${i.title} ${i.labels.join(' ')}`.toLowerCase().includes(term))) return false
    if (f.assignee === 'none' ? i.assignee : f.assignee && i.assignee?.id !== Number(f.assignee)) return false
    if (f.priority && i.priority !== f.priority) return false
    if (f.type && i.type !== f.type) return false
    if (f.status && i.status !== f.status) return false
    if (f.feature === 'none' ? i.feature_id : f.feature && i.feature_id !== Number(f.feature)) return false
    return true
  })
}

function SavedFilters({ projectId, filters, setFilters }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const [saved, setSaved] = useState([])
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  useEffect(() => {
    api(`/projects/${projectId}/filters`).then(setSaved).catch(() => {})
  }, [projectId])

  const active = Object.values(filters).some(Boolean)
  const same = (data) => Object.keys(EMPTY_FILTERS).every((k) => (data[k] || '') === filters[k])
  const current = saved.find((s) => same(s.data))

  const save = async (e) => {
    e.preventDefault()
    try {
      const created = await api(`/projects/${projectId}/filters`, { method: 'POST', body: { name, data: filters } })
      setSaved((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)))
      setNaming(false)
      setName('')
      toast('Filter saved')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const remove = async () => {
    try {
      await api(`/filters/${current.id}`, { method: 'DELETE' })
      setSaved((list) => list.filter((s) => s.id !== current.id))
      toast('Saved filter removed')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <>
      {saved.length > 0 && (
        <select
          className="select"
          value={current?.id || ''}
          onChange={(e) => {
            const pick = saved.find((s) => s.id === Number(e.target.value))
            setFilters(pick ? { ...EMPTY_FILTERS, ...pick.data } : EMPTY_FILTERS)
          }}
          aria-label="Saved filters"
        >
          <option value="">Saved filters…</option>
          {saved.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      {current ? (
        <button className="btn btn-ghost btn-sm" onClick={remove}><Trash2 size={13} /> Remove saved</button>
      ) : (
        active && <button className="btn btn-ghost btn-sm" onClick={() => setNaming(true)}><Bookmark size={13} /> Save filter</button>
      )}
      {naming && (
        <Modal title="Save this filter" onClose={() => setNaming(false)} size="sm">
          <form onSubmit={save}>
            <div className="modal-body">
              <Field label="Name" hint="Only you can see your saved filters.">
                <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. My urgent bugs" autoFocus required />
              </Field>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setNaming(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={!name.trim()}>Save</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}

function FilterBar({ projectId, statuses, filters, setFilters, members, features, showStatus, onCreate }) {
  const set = (name) => (e) => setFilters((f) => ({ ...f, [name]: e.target.value }))
  const active = Object.values(filters).some(Boolean)
  return (
    <div className="toolbar">
      <div className="input-icon">
        <Search size={15} />
        <input className="input search-input" placeholder="Filter issues…" value={filters.q} onChange={set('q')} />
      </div>
      <select className="select" value={filters.assignee} onChange={set('assignee')} aria-label="Assignee">
        <option value="">Any assignee</option>
        <option value="none">Unassigned</option>
        {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
      </select>
      {showStatus && (
        <select className="select" value={filters.status} onChange={set('status')} aria-label="Status">
          <option value="">Any status</option>
          {statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      )}
      {features.length > 0 && (
        <select className="select" value={filters.feature} onChange={set('feature')} aria-label="Feature" style={{ maxWidth: 190 }}>
          <option value="">Any feature</option>
          <option value="none">No feature</option>
          {features.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
        </select>
      )}
      <select className="select" value={filters.priority} onChange={set('priority')} aria-label="Priority">
        <option value="">Any priority</option>
        {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>
      <select className="select" value={filters.type} onChange={set('type')} aria-label="Type">
        <option value="">Any type</option>
        {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </select>
      {active && <button className="btn btn-ghost btn-sm" onClick={() => setFilters(EMPTY_FILTERS)}>Clear</button>}
      <SavedFilters projectId={projectId} filters={filters} setFilters={setFilters} />
      {onCreate && (
        <>
          <span className="grow" />
          <button className="btn btn-primary" onClick={onCreate}><Plus size={16} /> New issue</button>
        </>
      )}
    </div>
  )
}

/* ───────────── Board ───────────── */

function Board({ project, issues, filtered, onMove, onCreate }) {
  const openIssue = useOpenIssue()
  const [dragId, setDragId] = useState(null)
  const [overColumn, setOverColumn] = useState(null)
  const [beforeId, setBeforeId] = useState(null)

  const reset = () => {
    setDragId(null)
    setOverColumn(null)
    setBeforeId(null)
  }

  const drop = (status) => {
    if (dragId == null) return reset()
    // Position is computed against every issue in the column, not just the filtered ones.
    const column = issues.filter((i) => i.status === status && i.id !== dragId).sort((a, b) => a.position - b.position)
    const index = beforeId != null ? column.findIndex((i) => i.id === beforeId) : -1
    let position
    if (index >= 0) {
      const next = column[index].position
      const prev = index > 0 ? column[index - 1].position : next - 1000
      position = (prev + next) / 2
    } else {
      position = (column.length ? column[column.length - 1].position : 0) + 1000
    }
    const dragged = issues.find((i) => i.id === dragId)
    if (dragged && (dragged.status !== status || dragged.position !== position)) onMove(dragId, status, position)
    reset()
  }

  return (
    <div className="kanban" style={{ gridTemplateColumns: `repeat(${statusesOf(project).length}, minmax(250px, 1fr))` }}>
      {statusesOf(project).map((s) => {
        const cards = filtered.filter((i) => i.status === s.key).sort((a, b) => a.position - b.position)
        return (
          <div
            key={s.key}
            className={`kcol ${overColumn === s.key && dragId != null ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setOverColumn(s.key)
            }}
            onDrop={(e) => {
              e.preventDefault()
              drop(s.key)
            }}
          >
            <div className="kcol-header">
              <i style={{ background: s.color }} />
              {s.label}
              <span className="n">{cards.length}</span>
              <button className="btn btn-icon btn-sm btn-ghost" onClick={() => onCreate(s.key)} aria-label={`Add issue to ${s.label}`}>
                <Plus size={15} />
              </button>
            </div>
            <div className="kcol-body" onDragOver={(e) => e.target === e.currentTarget && setBeforeId(null)}>
              {cards.map((issue) => (
                <div
                  key={issue.id}
                  className={`kcard ${dragId === issue.id ? 'dragging' : ''} ${beforeId === issue.id && dragId !== issue.id ? 'drop-before' : ''}`}
                  draggable
                  tabIndex={0}
                  role="button"
                  onClick={() => openIssue(issue.id)}
                  onKeyDown={(e) => e.key === 'Enter' && openIssue(issue.id)}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', String(issue.id))
                    setDragId(issue.id)
                  }}
                  onDragEnd={reset}
                  onDragOver={() => setBeforeId(issue.id)}
                >
                  <div className="kcard-title">{issue.title}</div>
                  {issue.labels.length > 0 && (
                    <div className="row row-wrap" style={{ gap: 5 }}>
                      {issue.labels.slice(0, 3).map((l) => <span className="tag" key={l}>{l}</span>)}
                    </div>
                  )}
                  <div className="kcard-meta">
                    <TypeIcon type={issue.type} />
                    <span className="issue-key">{issue.key}</span>
                    <PriorityIcon priority={issue.priority} />
                    {issue.recurrence && <span className="due" title={`Repeats ${issue.recurrence}`}><Repeat size={12} /></span>}
                    <span className="spacer" />
                    {issue.checklist_total > 0 && (
                      <span className="due" title="Checklist"><ListChecks size={12} /> {issue.checklist_done}/{issue.checklist_total}</span>
                    )}
                    {issue.comment_count > 0 && (
                      <span className="due"><MessageSquare size={12} /> {issue.comment_count}</span>
                    )}
                    {issue.due_date && (
                      <span className={`due ${isOverdue(issue.due_date, issue.status === 'done') ? 'overdue' : ''}`}>
                        <CalendarDays size={12} /> {formatDate(issue.due_date)}
                      </span>
                    )}
                    <Avatar user={issue.assignee} size={22} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ───────────── List ───────────── */

const ORDER = {
  priority: PRIORITIES.map((p) => p.key),
}

export function IssueTable({ issues, showProject = false, bulk }) {
  const openIssue = useOpenIssue()
  const toast = useToast()
  const undo = useUndoDelete()
  const confirm = useConfirm()
  const [selected, setSelected] = useState(() => new Set())
  const [working, setWorking] = useState(false)
  const [sort, setSort] = useState({ field: 'key', dir: 'desc' })
  const onSort = (field) => setSort((s) => ({ field, dir: s.field === field && s.dir === 'asc' ? 'desc' : 'asc' }))

  const sorted = useMemo(() => {
    const value = (i) => {
      switch (sort.field) {
        case 'key': return i.id
        case 'title': return i.title.toLowerCase()
        case 'status': return i.status === 'done' ? 99 : (i.status_label || i.status).toLowerCase()
        case 'priority': return ORDER.priority.indexOf(i.priority)
        case 'assignee': return i.assignee?.full_name.toLowerCase() || '￿'
        case 'due': return i.due_date || '9999'
        default: return i.updated_at
      }
    }
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...issues].sort((a, b) => (value(a) > value(b) ? dir : value(a) < value(b) ? -dir : 0))
  }, [issues, sort])

  const chosen = sorted.filter((i) => selected.has(i.id))
  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleAll = () => setSelected(chosen.length === sorted.length ? new Set() : new Set(sorted.map((i) => i.id)))

  // One request at a time keeps the activity log ordered and avoids write contention.
  const runBulk = async (request, verb) => {
    setWorking(true)
    let failed = 0
    let firstError = ''
    for (const issue of chosen) {
      try {
        await request(issue)
      } catch (err) {
        failed += 1
        firstError = firstError || err.message
      }
    }
    setWorking(false)
    setSelected(new Set())
    notifyChanged()
    if (failed) toast(`${chosen.length - failed} ${verb}, ${failed} failed: ${firstError}`, 'error')
    else toast(`${chosen.length} issue${chosen.length === 1 ? '' : 's'} ${verb}`)
  }
  const bulkPatch = (changes) => runBulk((i) => api(`/issues/${i.id}`, { method: 'PATCH', body: changes }), 'updated')
  const bulkDelete = async () => {
    const ok = await confirm({
      title: `Delete ${chosen.length} issue${chosen.length === 1 ? '' : 's'}?`,
      message: 'They move to the recycle bin for 30 days.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) runBulk((i) => api(`/issues/${i.id}`, { method: 'DELETE' }), 'deleted')
  }
  const idOrNull = (value) => (value === 'none' ? null : Number(value))

  return (
    <>
    {bulk && chosen.length > 0 && (
      <div className="bulk-bar">
        <b>{chosen.length} selected</b>
        <select className="select" value="" disabled={working} onChange={(e) => bulkPatch({ status: e.target.value })} aria-label="Set status">
          <option value="">Set status…</option>
          {(bulk.statuses || []).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className="select" value="" disabled={working} onChange={(e) => bulkPatch({ priority: e.target.value })} aria-label="Set priority">
          <option value="">Set priority…</option>
          {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <select className="select" value="" disabled={working} onChange={(e) => bulkPatch({ assignee_id: idOrNull(e.target.value) })} aria-label="Set assignee">
          <option value="">Assign to…</option>
          <option value="none">Unassigned</option>
          {bulk.members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
        </select>
        {bulk.features.length > 0 && (
          <select className="select" value="" disabled={working} onChange={(e) => bulkPatch({ feature_id: idOrNull(e.target.value) })} aria-label="Set feature" style={{ maxWidth: 170 }}>
            <option value="">Set feature…</option>
            <option value="none">No feature</option>
            {bulk.features.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
          </select>
        )}
        {bulk.milestones.length > 0 && (
          <select className="select" value="" disabled={working} onChange={(e) => bulkPatch({ milestone_id: idOrNull(e.target.value) })} aria-label="Set milestone" style={{ maxWidth: 170 }}>
            <option value="">Set milestone…</option>
            <option value="none">No milestone</option>
            {bulk.milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        <span className="grow" />
        {working && <Spinner />}
        <button className="btn btn-sm btn-ghost danger-text" disabled={working} onClick={bulkDelete}><Trash2 size={13} /> Delete</button>
        <button className="btn btn-sm btn-ghost" disabled={working} onClick={() => setSelected(new Set())}>Cancel</button>
      </div>
    )}
    <div className="card table-wrap">
      <table className="table">
        <thead>
          <tr>
            {bulk && (
              <th style={{ width: 36 }}>
                <input type="checkbox" checked={sorted.length > 0 && chosen.length === sorted.length} onChange={toggleAll} aria-label="Select all issues" />
              </th>
            )}
            <SortHeader label="Issue" field="key" sort={sort} onSort={onSort} />
            <SortHeader label="Title" field="title" sort={sort} onSort={onSort} />
            <SortHeader label="Status" field="status" sort={sort} onSort={onSort} />
            <SortHeader label="Priority" field="priority" sort={sort} onSort={onSort} />
            <SortHeader label="Assignee" field="assignee" sort={sort} onSort={onSort} />
            <SortHeader label="Due" field="due" sort={sort} onSort={onSort} />
            <SortHeader label="Updated" field="updated" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((i) => (
            <tr key={i.id} className="clickable" onClick={() => openIssue(i.id)}>
              {bulk && (
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(i.id)} onChange={() => toggle(i.id)} aria-label={`Select ${i.key}`} />
                </td>
              )}
              <td>
                <span className="row" style={{ gap: 8 }}>
                  <TypeIcon type={i.type} />
                  <span className="issue-key">{i.key}</span>
                </span>
              </td>
              <td>
                <div className="cell-title truncate">{i.title}</div>
                {showProject && <div className="faint small">{i.project_name}</div>}
              </td>
              <td><StatusBadge issue={i} /></td>
              <td><PriorityIcon priority={i.priority} label /></td>
              <td>
                {i.assignee ? (
                  <span className="row" style={{ gap: 8 }}><Avatar user={i.assignee} size={22} /> {i.assignee.full_name}</span>
                ) : (
                  <span className="faint">Unassigned</span>
                )}
              </td>
              <td>
                {i.due_date ? (
                  <span className={`due ${isOverdue(i.due_date, i.status === 'done') ? 'overdue' : ''}`}>{formatDate(i.due_date)}</span>
                ) : (
                  <span className="faint">—</span>
                )}
              </td>
              <td className="muted small">{timeAgo(i.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  )
}

/* ───────────── Milestones ───────────── */

function MilestoneModal({ projectId, milestone, onClose, onSaved }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const [form, setForm] = useState({
    name: milestone?.name || '',
    description: milestone?.description || '',
    start_date: milestone?.start_date || '',
    due_date: milestone?.due_date || '',
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = { ...form, start_date: form.start_date || null, due_date: form.due_date || null }
      if (milestone) await api(`/milestones/${milestone.id}`, { method: 'PATCH', body })
      else await api(`/projects/${projectId}/milestones`, { method: 'POST', body })
      toast(milestone ? 'Milestone updated' : 'Milestone created')
      onSaved()
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <Modal title={milestone ? 'Edit milestone' : 'New milestone'} onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}
          <Field label="Name">
            <input className="input" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="v1.0 launch" autoFocus required />
          </Field>
          <Field label="Description">
            <textarea className="textarea" style={{ minHeight: 70 }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <div className="form-grid">
            <Field label="Start date">
              <input className="input" type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
            </Field>
            <Field label="Due date">
              <input className="input" type="date" value={form.due_date} min={form.start_date || undefined} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
            </Field>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? <Spinner /> : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

function Milestones({ project, milestones, reload }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const confirm = useConfirm()
  const [editing, setEditing] = useState(null) // null | 'new' | milestone

  const toggle = async (m) => {
    try {
      await api(`/milestones/${m.id}`, { method: 'PATCH', body: { status: m.status === 'open' ? 'closed' : 'open' } })
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const remove = async (m) => {
    const ok = await confirm({
      title: `Delete milestone “${m.name}”?`,
      message: 'It moves to the recycle bin for 30 days. Its issues stay.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    try {
      await api(`/milestones/${m.id}`, { method: 'DELETE' })
      undo('milestone', m.id, `Milestone “${m.name}”`, reload)
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <>
      <div className="toolbar">
        <span className="muted grow">Group issues into releases or phases and track their progress.</span>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> New milestone</button>
      </div>
      {milestones.length === 0 ? (
        <div className="card"><Empty icon={Flag} title="No milestones yet">Create a milestone, then assign issues to it from the issue panel.</Empty></div>
      ) : (
        <div className="grid grid-cards">
          {milestones.map((m) => (
            <div className="card card-pad stack" key={m.id} style={{ gap: 12, opacity: m.status === 'closed' ? 0.7 : 1 }}>
              <div className="row between">
                <h3 className="truncate">{m.name}</h3>
                <Badge color={byKey(MILESTONE_STAGES, m.stage).color}>{byKey(MILESTONE_STAGES, m.stage).label}</Badge>
              </div>
              {m.description && <p className="muted small">{m.description}</p>}
              {m.features.length > 0 && (
                <div className="row row-wrap" style={{ gap: 5 }}>
                  {m.features.map((f) => (
                    <span className="tag" key={f.id} title={`Feature · ${byKey(FEATURE_STAGES, f.stage).label}`}>
                      <i style={{ width: 6, height: 6, borderRadius: '50%', background: byKey(FEATURE_STAGES, f.stage).color }} /> {f.title} · {byKey(FEATURE_STAGES, f.stage).label}
                    </span>
                  ))}
                </div>
              )}
              <StageSignoff project={project} type="milestone" item={m} onChanged={reload} dense />
              <div>
                <div className="row between small muted" style={{ marginBottom: 6 }}>
                  <span>{m.done_count} of {m.issue_count} issues done</span>
                  <b>{m.progress}%</b>
                </div>
                <Progress value={m.progress} color={project.color} />
              </div>
              <div className="row between">
                {m.due_date ? (
                  <span className={`due ${isOverdue(m.due_date, m.status === 'closed') ? 'overdue' : ''}`}>
                    <CalendarDays size={12} /> Due {formatDate(m.due_date)}
                  </span>
                ) : <span className="due">No due date</span>}
                <span className="row" style={{ gap: 2 }}>
                  {(!project.signoff_gated || (project.can_approve && m.status === 'closed')) && <button className="btn btn-ghost btn-sm" onClick={() => toggle(m)}>{m.status === 'open' ? 'Close' : 'Reopen'}</button>}
                  <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setEditing(m)} aria-label="Edit milestone"><Pencil size={14} /></button>
                  <button className="btn btn-ghost btn-sm btn-icon danger-text" onClick={() => remove(m)} aria-label="Delete milestone"><Trash2 size={14} /></button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <MilestoneModal
          projectId={project.id}
          milestone={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
    </>
  )
}

/* ───────────── Members ───────────── */

function AccessModal({ project, member, onClose, reload }) {
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

function Members({ project, issues, reload }) {
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

function ActivityFeed({ projectId }) {
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

function TemplateCard({ project }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const confirm = useConfirm()
  const [templates, setTemplates] = useState([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => api('/templates').then(setTemplates).catch(() => {})
  useEffect(() => {
    load()
  }, [])

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/projects/${project.id}/template`, { method: 'POST', body: { name, description: `Based on ${project.name}` } })
      toast('Template saved. Choose it when creating a new project.')
      setName('')
      load()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (t) => {
    if (!(await confirm({ title: `Delete template “${t.name}”?`, message: 'Projects already created from it are not affected.', confirmLabel: 'Delete', danger: true }))) return
    try {
      await api(`/templates/${t.id}`, { method: 'DELETE' })
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div className="card card-pad stack">
      <div>
        <h2>Project templates</h2>
        <p className="muted small">
          Save this project's structure — features, milestones, phase checklists, documents and risks — to reuse for new projects.
          Issues, people and progress are not copied.
        </p>
      </div>
      <form className="row" onSubmit={save}>
        <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Template name, e.g. Client website" />
        <button className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? <Spinner /> : 'Save as template'}</button>
      </form>
      {templates.length > 0 && (
        <div>
          {templates.map((t) => (
            <div className="row" key={t.id} style={{ padding: '7px 0', borderTop: '1px solid var(--border)' }}>
              <span className="grow truncate">
                <b>{t.name}</b>{t.builtin && <span className="faint small"> · built-in</span>}
                <div className="faint small">
                  {t.summary.features} features · {t.summary.milestones} milestones · {t.summary.documents} documents · {t.summary.risks} risks · {t.summary.phase_checks} checklist items
                </div>
              </span>
              {t.can_delete && (
                <button className="btn btn-ghost btn-sm btn-icon danger-text" onClick={() => remove(t)} aria-label={`Delete template ${t.name}`}><Trash2 size={14} /></button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectSettings({ project, issues, reload }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const [form, setForm] = useState({
    name: project.name,
    description: project.description,
    status: project.status,
    phase: project.phase,
    color: project.color,
    start_date: project.start_date || '',
    due_date: project.due_date || '',
  })
  const [busy, setBusy] = useState(false)

  if (!project.can_manage) {
    return <div className="card"><Empty icon={Settings} title="Restricted">Only the project owner or an administrator can change project settings.</Empty></div>
  }

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/projects/${project.id}`, {
        method: 'PATCH',
        body: { ...form, start_date: form.start_date || null, due_date: form.due_date || null },
      })
      toast('Project saved')
      reload()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${project.name}?`,
      message: `The project and its ${project.issue_count} issue(s) move to the recycle bin. An administrator or the owner can restore it within 30 days.`,
      confirmLabel: 'Delete project',
      danger: true,
    })
    if (!ok) return
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' })
      undo('project', project.id, `Project ${project.name}`)
      notifyChanged()
      navigate('/projects')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div className="settings-section stack">
      <form className="card card-pad stack" onSubmit={save}>
        <h2>Project details</h2>
        <Field label="Name">
          <input className="input" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </Field>
        <ProjectFormFields form={form} setForm={setForm} />
        <div><button className="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? <Spinner /> : 'Save changes'}</button></div>
      </form>
      <LogoCard project={project} reload={reload} />
      <SignoffCard project={project} reload={reload} />
      <ShareLinksCard project={project} />
      <ClientFeedbackCard project={project} />
      <PlanGate feature="customization" compact>
        <WorkflowCard key={JSON.stringify(project.statuses)} project={project} issues={issues} reload={reload} />
        <FieldsCard project={project} reload={reload} />
        <IssueTemplatesCard project={project} />
      </PlanGate>
      <PlanGate feature="automation" compact><AutomationsCard project={project} /></PlanGate>
      <TemplateCard project={project} />
      <div className="card card-pad danger-zone row between row-wrap">
        <div>
          <h3>Delete this project</h3>
          <p className="muted small">All issues, comments, milestones and activity are removed.</p>
        </div>
        <button className="btn btn-danger" onClick={remove}><Trash2 size={15} /> Delete project</button>
      </div>
    </div>
  )
}

/* ───────────── Page ───────────── */

export default function ProjectDetail() {
  const { projectId } = useParams()
  const [params, setParams] = useSearchParams()
  const toast = useToast()
  const undo = useUndoDelete()
  const [project, setProject] = useState(null)
  const [issues, setIssues] = useState([])
  const [milestones, setMilestones] = useState([])
  const [features, setFeatures] = useState([])
  const [releases, setReleases] = useState([])
  const [risks, setRisks] = useState([])
  const [checks, setChecks] = useState([])
  const [creatingFeature, setCreatingFeature] = useState(false)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [createStatus, setCreateStatus] = useState(null)

  const tabs = tabsFor(project)
  const tab = tabs.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'overview'
  const groups = TAB_GROUPS.map((g) => ({ ...g, tabs: g.tabs.map((k) => tabs.find((t) => t.key === k)).filter(Boolean) })).filter((g) => g.tabs.length)
  const activeGroup = groups.find((g) => g.tabs.some((t) => t.key === tab)) || groups[0]
  const setTab = (key) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (key === 'overview') next.delete('tab')
      else next.set('tab', key)
      return next
    })

  const featureParam = params.get('feature')
  const setFeatureParam = (id) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (id) next.set('feature', String(id))
      else next.delete('feature')
      return next
    })

  const load = useCallback(async () => {
    try {
      const p = await api(`/projects/${projectId}`)
      // Only ask for the sections this person may see; a refusal never blocks the page.
      const part = (section, path) => (p.sections.includes(section) ? api(path).catch(() => []) : Promise.resolve([]))
      const [i, m, f, r, rk, ck] = await Promise.all([
        part('issues', `/issues?project_id=${projectId}&limit=1000`),
        part('milestones', `/projects/${projectId}/milestones`),
        part('features', `/projects/${projectId}/features`),
        part('releases', `/projects/${projectId}/releases`),
        part('risks', `/projects/${projectId}/risks`),
        api(`/projects/${projectId}/phase-checks`).catch(() => []),
      ])
      setProject(p)
      setIssues(i)
      setMilestones(m)
      setFeatures(f)
      setReleases(r)
      setRisks(rk)
      setChecks(ck)
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [projectId])

  useEffect(() => {
    setProject(null)
    setFilters(EMPTY_FILTERS)
    load()
    return onChanged(load)
  }, [load])

  const filtered = useMemo(
    () => applyFilters(issues, tab === 'board' ? { ...filters, status: '' } : filters),
    [issues, filters, tab],
  )

  const moveIssue = async (id, status, position) => {
    const previous = issues
    setIssues((list) => list.map((i) => (i.id === id ? { ...i, status, position } : i)))
    try {
      await api(`/issues/${id}`, { method: 'PATCH', body: { status, position } })
      notifyChanged()
    } catch (err) {
      setIssues(previous)
      toast(err.message, 'error')
    }
  }

  if (error && !project) {
    return (
      <div className="page">
        <div className="card">
          <Empty icon={Search} title="Project not found" action={<Link className="btn" to="/projects">Back to projects</Link>}>{error}</Empty>
        </div>
      </div>
    )
  }
  if (!project) return <PageSkeleton variant="project" />
  const highRisks = risks.filter((r) => r.severity === 'high' && r.status !== 'closed').length

  return (
    <div className={`page ${project.can_edit ? '' : 'read-only'}`}>
      <Link to="/projects" className="row small muted" style={{ gap: 4, marginBottom: 10, width: 'fit-content' }}>
        <ChevronLeft size={14} /> Projects
      </Link>
      <div className="page-header">
        <div className="row" style={{ gap: 14, minWidth: 0 }}>
          <ProjectIcon project={project} size={44} />
          <div style={{ minWidth: 0 }}>
            <div className="row row-wrap">
              <h1>{project.name}</h1>
              <ProjectStatusBadge status={project.status} />
            </div>
            <p className="row row-wrap small" style={{ gap: 14 }}>
              <span>{project.open_count} open · {project.done_count} done</span>
              {project.due_date && (
                <span className={`due ${isOverdue(project.due_date, project.status === 'completed') ? 'overdue' : ''}`}>
                  <CalendarDays size={12} /> Due {formatDate(project.due_date, true)}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="row">
          <AvatarStack users={project.members} max={5} size={30} />
        </div>
      </div>

      {!project.can_edit && (
        <div className="callout no-print" style={{ marginBottom: 14 }}>
          <ShieldAlert size={16} />
          <span>You have <b>view-only</b> access to this project. Ask the owner{project.owner ? `, ${project.owner.full_name},` : ''} if you need to make changes.</span>
        </div>
      )}
      <div className="tab-groups" role="tablist" aria-label="Project areas">
        {groups.map((g) => (
          <button
            key={g.key}
            role="tab"
            aria-selected={g.key === activeGroup.key}
            className={`tab-group ${g.key === activeGroup.key ? 'active' : ''}`}
            onClick={() => setTab(g.key === activeGroup.key ? tab : g.tabs[0].key)}
          >
            {g.label}
            {g.tabs.some((t) => t.key === 'risks') && highRisks > 0 && <span className="pill">{highRisks}</span>}
          </button>
        ))}
      </div>
      <div className="tabs" role="tablist" aria-label={`${activeGroup.label} sections`}>
        {activeGroup.tabs.map(({ key, label, icon: Icon }) => (
          <button key={key} role="tab" aria-selected={tab === key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            <Icon size={15} /> {label}
            {key === 'list' && <span className="pill">{issues.length}</span>}
            {key === 'features' && <span className="pill">{features.length}</span>}
            {key === 'risks' && risks.some((r) => r.severity === 'high' && r.status !== 'closed') && (
              <span className="pill alert">{risks.filter((r) => r.severity === 'high' && r.status !== 'closed').length}</span>
            )}
            {key === 'members' && <span className="pill">{project.members.length}</span>}
          </button>
        ))}
      </div>

      {(tab === 'board' || tab === 'list') && (
        <>
          <FilterBar projectId={project.id} statuses={statusesOf(project)} filters={filters} setFilters={setFilters} members={project.members} features={features} showStatus={tab === 'list'} onCreate={project.can_edit ? () => setCreateStatus('todo') : undefined} />
          {issues.length === 0 ? (
            <div className="card">
              <Empty
                icon={Columns3}
                title="No issues yet"
                action={<button className="btn btn-primary" onClick={() => setCreateStatus('todo')}><Plus size={16} /> New issue</button>}
              >
                Create the first issue to start tracking work in {project.name}.
              </Empty>
            </div>
          ) : tab === 'board' ? (
            <Board project={project} issues={issues} filtered={filtered} onMove={moveIssue} onCreate={setCreateStatus} />
          ) : filtered.length === 0 ? (
            <div className="card"><Empty icon={Search} title="No issues match these filters" /></div>
          ) : (
            <IssueTable issues={filtered} bulk={project.can_edit ? { statuses: statusesOf(project), members: project.members, features, milestones: milestones.filter((m) => m.status === 'open') } : undefined} />
          )}
        </>
      )}
      {tab === 'overview' && (
        <Overview project={project} issues={issues} milestones={milestones} features={features} releases={releases} risks={risks} checks={checks} setTab={setTab} reload={load} />
      )}
      {tab === 'features' && (
        <Features project={project} features={features} onOpen={setFeatureParam} onCreate={() => setCreatingFeature(true)} />
      )}
      {tab === 'releases' && <Releases project={project} releases={releases} features={features} />}
      {tab === 'timeline' && (
        <ProjectTimeline project={project} issues={issues} milestones={milestones} features={features} onCreate={() => setCreateStatus('todo')} />
      )}
      {tab === 'risks' && <Risks project={project} risks={risks} />}
      {tab === 'sprints' && <PlanGate feature="sprints"><Sprints project={project} /></PlanGate>}
      {tab === 'approvals' && <><PlanGate feature="approvals"><Approvals project={project} /></PlanGate><div style={{ marginTop: 16 }}><ClientFeedbackCard project={project} /></div></>}
      {tab === 'tests' && <Tests project={project} features={features} />}
      {tab === 'docs' && <Documents key={project.id} project={project} />}
      {tab === 'reports' && <Reports project={project} issues={issues} features={features} milestones={milestones} risks={risks} />}
      {tab === 'milestones' && <Milestones project={project} milestones={milestones} reload={load} />}
      {tab === 'members' && <Members project={project} issues={issues} reload={load} />}
      {tab === 'activity' && <ActivityFeed projectId={project.id} />}
      {tab === 'settings' && <ProjectSettings key={project.id} project={project} issues={issues} reload={load} />}

      {(featureParam || creatingFeature) && (
        <FeatureModal
          key={featureParam || 'new'}
          project={project}
          featureId={creatingFeature ? null : Number(featureParam)}
          releases={releases}
          onClose={() => (creatingFeature ? setCreatingFeature(false) : setFeatureParam(null))}
        />
      )}

      {createStatus && (
        <IssueForm
          projects={[project]}
          defaultProjectId={project.id}
          defaultStatus={createStatus}
          onClose={() => setCreateStatus(null)}
        />
      )}
    </div>
  )
}
