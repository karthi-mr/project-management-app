import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Flag, Pencil, Play, Plus, Target, Trash2, Zap } from 'lucide-react'
import { api, notifyChanged, onChanged } from '../api'
import { useConfirm, useToast } from '../context'
import {
  Avatar,
  Badge,
  Empty,
  Field,
  Modal,
  PageSkeleton,
  PriorityIcon,
  Progress,
  Spinner,
  StatusBadge,
  TypeIcon,
  dayToDate,
  formatDate,
  parseDay,
  todayDay,
  useOpenIssue,
} from '../ui'

const STATUS_META = {
  active: { label: 'Active', color: '#22c55e' },
  planned: { label: 'Planned', color: '#3b82f6' },
  completed: { label: 'Completed', color: '#94a3b8' },
}

function SprintModal({ project, sprint, onClose, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState({
    name: sprint?.name || '',
    goal: sprint?.goal || '',
    start_date: sprint?.start_date || '',
    end_date: sprint?.end_date || '',
  })
  const [busy, setBusy] = useState(false)
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    const body = { ...form, start_date: form.start_date || null, end_date: form.end_date || null }
    try {
      if (sprint) await api(`/sprints/${sprint.id}`, { method: 'PATCH', body })
      else await api(`/projects/${project.id}/sprints`, { method: 'POST', body })
      toast(sprint ? 'Sprint saved' : 'Sprint planned')
      onSaved()
      onClose()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }

  return (
    <Modal title={sprint ? `Edit ${sprint.name}` : 'Plan a sprint'} onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <div className="modal-body">
          <Field label="Name"><input className="input" value={form.name} maxLength={80} onChange={set('name')} placeholder="Sprint 1" autoFocus required /></Field>
          <Field label="Sprint goal" hint="What the team commits to deliver">
            <textarea className="textarea" style={{ minHeight: 70 }} value={form.goal} onChange={set('goal')} placeholder="e.g. Customers can pay by card" />
          </Field>
          <div className="form-grid">
            <Field label="Start"><input className="input" type="date" value={form.start_date} onChange={set('start_date')} /></Field>
            <Field label="End"><input className="input" type="date" value={form.end_date} min={form.start_date || undefined} onChange={set('end_date')} /></Field>
          </div>
          {!sprint && <span className="hint">Leave the dates empty to set them when you start the sprint (two weeks by default).</span>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? <Spinner /> : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

function CompleteModal({ sprint, sprints, onClose, onDone }) {
  const toast = useToast()
  const targets = sprints.filter((s) => s.status === 'planned')
  const [moveTo, setMoveTo] = useState(targets[0]?.id ? String(targets[0].id) : '')
  const unfinished = sprint.issue_count - sprint.done_count

  const submit = async () => {
    try {
      await api(`/sprints/${sprint.id}/complete`, { method: 'POST', body: { move_to: moveTo ? Number(moveTo) : null } })
      toast(`${sprint.name} completed`)
      onDone()
      onClose()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <Modal title={`Complete ${sprint.name}`} onClose={onClose} size="sm">
      <div className="modal-body">
        <p><b>{sprint.done_count}</b> of {sprint.issue_count} issues are done.</p>
        {unfinished > 0 ? (
          <Field label={`Move the ${unfinished} unfinished issue${unfinished === 1 ? '' : 's'} to`}>
            <select className="select" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              {targets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              <option value="">The backlog</option>
            </select>
          </Field>
        ) : <p className="muted">Everything was finished. Nice work.</p>}
      </div>
      <div className="modal-footer">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit}>Complete sprint</button>
      </div>
    </Modal>
  )
}

/** Remaining open issues per day of the sprint, against a straight ideal line. */
function SprintBurndown({ sprint, issues, color }) {
  const start = parseDay(sprint.start_date)
  const end = parseDay(sprint.end_date)
  if (start == null || end == null || end <= start) return null
  const today = todayDay()
  const total = issues.length
  const days = Array.from({ length: end - start + 1 }, (_, n) => start + n)
  const remaining = days.map((day) => (day > today ? null : issues.filter((i) => !(i.status === 'done' && i.completed_at && parseDay(i.completed_at.slice(0, 10)) <= day)).length))
  const width = 560
  const height = 170
  const pad = { l: 28, r: 10, t: 10, b: 22 }
  const x = (n) => pad.l + (n / (days.length - 1)) * (width - pad.l - pad.r)
  const y = (v) => pad.t + (1 - v / Math.max(1, total)) * (height - pad.t - pad.b)
  const actual = remaining.map((v, n) => (v == null ? null : `${x(n)},${y(v)}`)).filter(Boolean).join(' ')
  const step = Math.max(1, Math.ceil(days.length / 8))
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="area-chart" role="img" aria-label="Sprint burndown">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pad.l} x2={width - pad.r} y1={y(total * f)} y2={y(total * f)} className="grid" />
          <text x={pad.l - 6} y={y(total * f) + 3} textAnchor="end">{Math.round(total * f)}</text>
        </g>
      ))}
      {days.map((day, n) => (n % step === 0 || n === days.length - 1 ? <text key={day} x={x(n)} y={height - 5} textAnchor="middle">{dayToDate(day).getUTCDate()}</text> : null))}
      <line x1={x(0)} y1={y(total)} x2={x(days.length - 1)} y2={y(0)} stroke="var(--text-3)" strokeDasharray="5 5" strokeWidth="1.5" />
      <polyline points={actual} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
      {today >= start && today <= end && <line x1={x(today - start)} x2={x(today - start)} y1={pad.t} y2={height - pad.b} stroke="var(--danger)" opacity="0.5" />}
    </svg>
  )
}

function IssueRow({ issue, action }) {
  const openIssue = useOpenIssue()
  return (
    <div className="list-row" style={{ padding: '8px 14px' }}>
      <TypeIcon type={issue.type} />
      <span className="issue-key">{issue.key}</span>
      <button className="feature-title truncate grow" style={{ fontSize: 13.5, fontWeight: 550 }} onClick={() => openIssue(issue.id)}>{issue.title}</button>
      {issue.estimate_hours != null && <span className="faint small">{issue.estimate_hours}h</span>}
      <PriorityIcon priority={issue.priority} />
      <Avatar user={issue.assignee} size={22} />
      <span className="hide-mobile"><StatusBadge issue={issue} /></span>
      {action}
    </div>
  )
}

export default function Sprints({ project }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [sprints, setSprints] = useState(null)
  const [issues, setIssues] = useState([])
  const [editing, setEditing] = useState(null) // null | 'new' | sprint
  const [completing, setCompleting] = useState(null)
  const [selectedId, setSelectedId] = useState(null)

  const load = () =>
    Promise.all([api(`/projects/${project.id}/sprints`), api(`/issues?project_id=${project.id}&limit=1000`)])
      .then(([s, i]) => {
        setSprints(s)
        setIssues(i)
      })
      .catch((err) => toast(err.message, 'error'))

  useEffect(() => {
    load()
    return onChanged(load)
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = useMemo(() => (sprints || []).filter((s) => s.status !== 'completed'), [sprints])
  const selected = (sprints || []).find((s) => s.id === selectedId) || open[0] || null
  const backlog = issues.filter((i) => !i.sprint_id && i.status !== 'done')
  const inSprint = (s) => issues.filter((i) => i.sprint_id === s.id)

  const move = async (issue, sprintId) => {
    try {
      await api(`/issues/${issue.id}`, { method: 'PATCH', body: { sprint_id: sprintId } })
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const start = async (s) => {
    try {
      await api(`/sprints/${s.id}/start`, { method: 'POST' })
      toast(`${s.name} started`)
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const remove = async (s) => {
    const ok = await confirm({ title: `Delete ${s.name}?`, message: 'Its issues go back to the backlog.', confirmLabel: 'Delete sprint', danger: true })
    if (!ok) return
    try {
      await api(`/sprints/${s.id}`, { method: 'DELETE' })
      toast('Sprint deleted')
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  if (!sprints) return <PageSkeleton variant="list" padded={false} />

  const completed = sprints.filter((s) => s.status === 'completed')
  const velocity = completed.slice(0, 3)
  const avgVelocity = velocity.length ? Math.round(velocity.reduce((sum, s) => sum + (s.summary?.completed || 0), 0) / velocity.length * 10) / 10 : null
  const selectedIssues = selected ? inSprint(selected) : []

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <span className="muted grow">
          Plan work in short iterations.{avgVelocity != null && <> Recent velocity: <b style={{ color: 'var(--text)' }}>{avgVelocity}</b> issues per sprint.</>}
        </span>
        {project.can_edit && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> Plan sprint</button>}
      </div>

      {sprints.length === 0 ? (
        <div className="card">
          <Empty icon={Zap} title="No sprints yet" action={project.can_edit && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> Plan the first sprint</button>}>
            A sprint is a fixed period, usually one or two weeks, with a goal and a set of issues the team commits to finishing.
          </Empty>
        </div>
      ) : (
        <>
          {open.length > 0 && (
            <div className="pipeline">
              {open.map((s) => (
                <button key={s.id} className={`pipe ${selected?.id === s.id ? 'active' : ''}`} style={{ '--c': STATUS_META[s.status].color }} onClick={() => setSelectedId(s.id)}>
                  <i /> {s.name} <b>{s.issue_count}</b>
                </button>
              ))}
            </div>
          )}

          {selected && (
            <div className="grid sprint-grid">
              <div className="card">
                <div className="card-header">
                  <div style={{ minWidth: 0 }}>
                    <div className="row row-wrap" style={{ gap: 8 }}>
                      <h2>{selected.name}</h2>
                      <Badge color={STATUS_META[selected.status].color}>{STATUS_META[selected.status].label}</Badge>
                    </div>
                    <div className="small muted row row-wrap" style={{ gap: 12, marginTop: 3 }}>
                      {selected.start_date && <span className="due"><CalendarDays size={12} /> {formatDate(selected.start_date)} – {formatDate(selected.end_date)}</span>}
                      {selected.status === 'active' && selected.end_date && <span>{Math.max(0, parseDay(selected.end_date) - todayDay())} days left</span>}
                    </div>
                  </div>
                  {project.can_edit && (
                    <span className="row" style={{ gap: 4 }}>
                      {selected.status === 'planned' && <button className="btn btn-primary btn-sm" onClick={() => start(selected)}><Play size={13} /> Start</button>}
                      {selected.status === 'active' && <button className="btn btn-primary btn-sm" onClick={() => setCompleting(selected)}><Flag size={13} /> Complete</button>}
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setEditing(selected)} aria-label="Edit sprint"><Pencil size={14} /></button>
                      {selected.status !== 'active' && <button className="btn btn-ghost btn-sm btn-icon danger-text" onClick={() => remove(selected)} aria-label="Delete sprint"><Trash2 size={14} /></button>}
                    </span>
                  )}
                </div>
                <div className="card-body">
                  {selected.goal && <div className="callout" style={{ marginBottom: 12 }}><Target size={16} /><span><b>Goal:</b> {selected.goal}</span></div>}
                  <div className="row between small muted" style={{ marginBottom: 6 }}>
                    <span>{selected.done_count} of {selected.issue_count} issues done · {selected.done_hours}h of {selected.estimate_hours}h estimated</span>
                    <b>{selected.progress}%</b>
                  </div>
                  <Progress value={selected.progress} color={project.color} />
                </div>
                {selectedIssues.length === 0 ? (
                  <p className="muted small" style={{ padding: '0 20px 18px' }}>No issues yet. Add them from the backlog.</p>
                ) : (
                  selectedIssues
                    .sort((a, b) => (a.status === 'done') - (b.status === 'done'))
                    .map((i) => (
                      <IssueRow key={i.id} issue={i} action={project.can_edit && <button className="btn btn-ghost btn-sm" onClick={() => move(i, null)} title="Move back to the backlog">Remove</button>} />
                    ))
                )}
              </div>

              <div className="stack" style={{ gap: 16 }}>
                {selected.status !== 'planned' && (
                  <div className="card">
                    <div className="card-header">
                      <h2>Burndown</h2>
                      <span className="row small muted" style={{ gap: 12 }}>
                        <span className="legend-item"><i style={{ background: project.color }} />Open issues</span>
                        <span className="legend-item"><i style={{ background: 'var(--text-3)' }} />Ideal</span>
                      </span>
                    </div>
                    <div className="card-body"><SprintBurndown sprint={selected} issues={selectedIssues} color={project.color} /></div>
                  </div>
                )}
                <div className="card">
                  <div className="card-header" style={{ paddingBottom: 10 }}>
                    <h2>Backlog</h2>
                    <span className="faint small">{backlog.length} open issue{backlog.length === 1 ? '' : 's'}</span>
                  </div>
                  {backlog.length === 0 ? (
                    <p className="muted small" style={{ padding: '0 20px 18px' }}>Every open issue is already in a sprint.</p>
                  ) : (
                    <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                      {backlog.map((i) => (
                        <IssueRow key={i.id} issue={i} action={project.can_edit && <button className="btn btn-sm" onClick={() => move(i, selected.id)}><Plus size={13} /> Add</button>} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {completed.length > 0 && (
            <div className="card table-wrap">
              <div className="card-header" style={{ paddingBottom: 8 }}><h2>Completed sprints</h2></div>
              <table className="table">
                <thead><tr><th>Sprint</th><th>Dates</th><th>Committed</th><th>Completed</th><th>Carried over</th><th>Hours done</th></tr></thead>
                <tbody>
                  {completed.map((s) => (
                    <tr key={s.id}>
                      <td><b>{s.name}</b>{s.goal && <div className="faint small truncate" style={{ maxWidth: 300 }}>{s.goal}</div>}</td>
                      <td className="muted small">{s.start_date ? `${formatDate(s.start_date)} – ${formatDate(s.end_date)}` : '—'}</td>
                      <td>{s.summary?.committed ?? s.issue_count}</td>
                      <td>{s.summary?.completed ?? s.done_count}</td>
                      <td>{s.summary?.carried_over ?? 0}</td>
                      <td>{s.summary?.completed_hours ?? s.done_hours}h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {editing && <SprintModal project={project} sprint={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
      {completing && <CompleteModal sprint={completing} sprints={sprints} onClose={() => setCompleting(null)} onDone={() => { load(); notifyChanged() }} />}
    </div>
  )
}

