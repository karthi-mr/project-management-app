import { useEffect, useMemo, useState } from 'react'
import { Bookmark, CalendarDays, ListChecks, MessageSquare, Plus, Repeat, Search, Trash2 } from 'lucide-react'
import { api, notifyChanged } from '../../api'
import { useConfirm, useToast } from '../../context'
import { useUndoDelete } from '../../components/useUndo'
import { Avatar, Field, Modal, PRIORITIES, PriorityIcon, statusesOf, SortHeader, Spinner, StatusBadge, TYPES, TypeIcon, formatDate, isOverdue, timeAgo, useOpenIssue } from '../../ui'

export const EMPTY_FILTERS = { q: '', assignee: '', priority: '', type: '', status: '', feature: '' }

export function applyFilters(issues, f) {
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

export function SavedFilters({ projectId, filters, setFilters }) {
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

export function FilterBar({ projectId, statuses, filters, setFilters, members, features, showStatus, onCreate }) {
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

export function Board({ project, issues, filtered, onMove, onCreate }) {
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

export const ORDER = {
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
