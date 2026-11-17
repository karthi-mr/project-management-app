import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Download, FileText, Pencil, Plus, Printer, ShieldAlert, Stamp, Trash2, X } from 'lucide-react'
import { api, notifyChanged } from '../api'
import { RichEditor, RichText } from '../components/RichText'
import { ApprovalBadge, RequestApprovalModal } from '../components/ProjectRules'
import { useConfirm, useToast } from '../context'
import { useUndoDelete } from '../components/useUndo'
import {
  Avatar,
  Badge,
  Empty,
  FEATURE_STAGES,
  Field,
  Modal,
  PHASES,
  PRIORITIES,
  Progress,
  RISK_LEVELS,
  RISK_STATUSES,
  PageSkeleton,
  STATUSES,
  Spinner,
  byKey,
  dayToDate,
  dayToISO,
  downloadCsv,
  formatDate,
  isOverdue,
  parseDay,
  timeAgo,
  todayDay,
} from '../ui'

/* ───────────── Phase checklist (exit criteria) ───────────── */

export function PhaseChecklist({ project, checks, reload }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const [phase, setPhase] = useState(project.phase)
  const [draft, setDraft] = useState('')
  const [signing, setSigning] = useState(false)
  const [approvals, setApprovals] = useState([])
  useEffect(() => {
    if (!signing) api(`/projects/${project.id}/approvals`).then(setApprovals).catch(() => {})
  }, [project.id, signing])

  useEffect(() => setPhase(project.phase), [project.phase])

  const call = async (path, options) => {
    try {
      await api(path, options)
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const add = (e) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    call(`/projects/${project.id}/phase-checks`, { method: 'POST', body: { phase, text } })
  }

  const items = checks.filter((c) => c.phase === phase)
  const meta = byKey(PHASES, phase)

  return (
    <div className="card">
      <div className="card-header">
        <h2>Phase checklist</h2>
        <select className="select input-sm" style={{ width: 'auto' }} value={phase} onChange={(e) => setPhase(e.target.value)} aria-label="Phase">
          {PHASES.map((p) => {
            const list = checks.filter((c) => c.phase === p.key)
            return (
              <option key={p.key} value={p.key}>
                {p.label}{list.length ? ` (${list.filter((c) => c.done).length}/${list.length})` : ''}{p.key === project.phase ? ' · current' : ''}
              </option>
            )
          })}
        </select>
      </div>
      <div className="card-body">
        <p className="small muted" style={{ marginBottom: 8 }}>What must be true before leaving {meta.label}.</p>
        {items.map((c) => (
          <div className="check-row" key={c.id}>
            <label>
              <input type="checkbox" checked={c.done} disabled={!project.can_edit} onChange={(e) => call(`/phase-checks/${c.id}`, { method: 'PATCH', body: { done: e.target.checked } })} />
              <span className={c.done ? 'done' : ''}>{c.text}</span>
            </label>
            {c.done && c.done_by && <span className="faint small hide-mobile" style={{ whiteSpace: 'nowrap' }}>{c.done_by.full_name} · {timeAgo(c.done_at)}</span>}
            <button className="btn btn-icon btn-sm btn-ghost" onClick={() => call(`/phase-checks/${c.id}`, { method: 'DELETE' })} aria-label={`Remove ${c.text}`}>
              <X size={13} />
            </button>
          </div>
        ))}
        {items.length === 0 && <p className="muted small">No items for this phase yet.</p>}
        {project.can_edit && <form className="row" style={{ marginTop: 8 }} onSubmit={add}>
          <input className="input input-sm" value={draft} maxLength={300} onChange={(e) => setDraft(e.target.value)} placeholder={`Add an exit criterion for ${meta.label}`} />
          <button className="btn btn-sm btn-icon" disabled={!draft.trim()} aria-label="Add item"><Plus size={14} /></button>
        </form>}
        {(() => {
          const latest = approvals.find((a) => a.kind === 'phase' && a.phase === phase && ['pending', 'approved'].includes(a.status))
          if (!latest) return <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setSigning(true)}><Stamp size={13} /> Request sign-off for {meta.label}</button>
          return (
            <div className="small muted row" style={{ marginTop: 10, gap: 6 }}>
              <Stamp size={13} /> {meta.label} sign-off: <ApprovalBadge approval={latest} />
              {latest.status === 'approved' ? `by ${latest.approver?.full_name || 'a manager'}` : `requested by ${latest.requester?.full_name || 'someone'}, waiting for the owner or a manager`}
            </div>
          )
        })()}
        {signing && <RequestApprovalModal project={project} kind="phase" phase={phase} defaultTitle={`Sign off the ${meta.label} phase`} onClose={() => setSigning(false)} />}
        {project.can_edit && PHASES.some((p) => !checks.some((c) => c.phase === p.key)) && (
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => call(`/projects/${project.id}/phase-checks/defaults`, { method: 'POST' })}>
            Add suggested items to empty phases
          </button>
        )}
      </div>
    </div>
  )
}

/* ───────────── Documents ───────────── */

export function Documents({ project }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const confirm = useConfirm()
  const [docs, setDocs] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [mode, setMode] = useState('read')
  const [busy, setBusy] = useState(false)

  const selected = docs?.find((d) => d.id === selectedId) || null
  const dirty = selected && (title !== selected.title || content !== selected.content)

  const open = (doc, nextMode) => {
    setSelectedId(doc?.id ?? null)
    setTitle(doc?.title ?? '')
    setContent(doc?.content ?? '')
    setMode(nextMode || (doc?.content ? 'read' : 'edit'))
  }

  useEffect(() => {
    api(`/projects/${project.id}/documents`)
      .then((rows) => {
        setDocs(rows)
        if (rows.length) open(rows[0])
      })
      .catch((err) => toast(err.message, 'error'))
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const switchTo = async (doc) => {
    if (doc.id === selectedId) return
    if (dirty && !(await confirm({ title: 'Discard unsaved changes?', message: `Your edits to “${selected.title}” have not been saved.`, confirmLabel: 'Discard', danger: true }))) return
    open(doc)
  }

  const create = async () => {
    if (dirty && !(await confirm({ title: 'Discard unsaved changes?', message: `Your edits to “${selected.title}” have not been saved.`, confirmLabel: 'Discard', danger: true }))) return
    try {
      const doc = await api(`/projects/${project.id}/documents`, { method: 'POST', body: { title: 'Untitled document', content: '' } })
      setDocs((list) => [...list, doc])
      open(doc, 'edit')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      const doc = await api(`/documents/${selectedId}`, { method: 'PATCH', body: { title: title.trim() || 'Untitled document', content } })
      setDocs((list) => list.map((d) => (d.id === doc.id ? doc : d)))
      setTitle(doc.title)
      toast('Document saved')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!(await confirm({ title: `Delete “${selected.title}”?`, message: 'It moves to the recycle bin for 30 days.', confirmLabel: 'Delete document', danger: true }))) return
    try {
      await api(`/documents/${selectedId}`, { method: 'DELETE' })
      const rest = docs.filter((d) => d.id !== selectedId)
      setDocs(rest)
      open(rest[0] || null)
      undo('document', selectedId, `“${selected.title}”`, () => window.location.reload())
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  if (!docs) return <PageSkeleton variant="list" padded={false} />
  if (docs.length === 0) {
    return (
      <div className="card">
        <Empty icon={FileText} title="Keep the project's knowledge in one place" action={<button className="btn btn-primary" onClick={create}><Plus size={16} /> New document</button>}>
          Write requirements, design decisions, meeting notes and runbooks here so they stay with the project.
        </Empty>
      </div>
    )
  }

  return (
    <div className="docs">
      <div className="card docs-list">
        <button className="btn btn-sm" style={{ margin: 10 }} onClick={create}><Plus size={14} /> New document</button>
        {docs.map((d) => (
          <button key={d.id} className={`docs-item ${d.id === selectedId ? 'active' : ''}`} onClick={() => switchTo(d)}>
            <FileText size={15} />
            <span className="grow truncate">{d.id === selectedId ? title || 'Untitled document' : d.title}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="card docs-editor">
          <div className="docs-toolbar">
            <input className="docs-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-label="Document title" />
            <div className="segmented compact no-print">
              <button type="button" className={mode === 'read' ? 'active' : ''} onClick={() => setMode('read')}>Read</button>
              <button type="button" className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}><Pencil size={13} /> Edit</button>
            </div>
            <button className="btn btn-primary btn-sm no-print" onClick={save} disabled={!dirty || busy}>{busy ? <Spinner /> : dirty ? 'Save' : 'Saved'}</button>
            <button className="btn btn-ghost btn-sm btn-icon danger-text no-print" onClick={remove} aria-label="Delete document"><Trash2 size={14} /></button>
          </div>
          {mode === 'edit' ? (
            <div style={{ padding: 14 }} onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && (e.preventDefault(), dirty && save())}>
              <RichEditor value={content} onChange={setContent} members={project.members} minHeight={380} placeholder="Start writing… Use the toolbar for headings, lists, tables and links, or paste images straight in." />
            </div>
          ) : (
            <div className="md">
              {content.trim() ? <RichText text={content} members={project.members} className="flush" /> : <p className="muted">This document is empty. Switch to Edit to start writing.</p>}
            </div>
          )}
          <div className="docs-foot small faint">
            Last edited {timeAgo(selected.updated_at)}{selected.updated_by && ` by ${selected.updated_by.full_name}`} · ⌘/Ctrl + S saves
          </div>
        </div>
      )}
    </div>
  )
}

/* ───────────── Risks ───────────── */

function RiskModal({ project, risk, onClose }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const confirm = useConfirm()
  const [form, setForm] = useState({
    title: risk?.title || '',
    description: risk?.description || '',
    mitigation: risk?.mitigation || '',
    probability: risk?.probability || 'medium',
    impact: risk?.impact || 'medium',
    status: risk?.status || 'open',
    owner_id: risk?.owner?.id || '',
    review_date: risk?.review_date || '',
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const body = { ...form, owner_id: form.owner_id ? Number(form.owner_id) : null, review_date: form.review_date || null }
    try {
      if (risk) await api(`/risks/${risk.id}`, { method: 'PATCH', body })
      else await api(`/projects/${project.id}/risks`, { method: 'POST', body })
      toast(risk ? 'Risk saved' : 'Risk logged')
      notifyChanged()
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!(await confirm({ title: `Remove risk “${risk.title}”?`, confirmLabel: 'Remove', danger: true }))) return
    try {
      await api(`/risks/${risk.id}`, { method: 'DELETE' })
      undo('risk', risk.id, `Risk “${risk.title}”`)
      notifyChanged()
      onClose()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <Modal title={risk ? 'Edit risk' : 'Log a risk'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}
          <Field label="Risk or blocker">
            <input className="input" value={form.title} onChange={set('title')} maxLength={200} placeholder="e.g. Payment provider approval may be late" autoFocus required />
          </Field>
          <Field label="What could happen">
            <textarea className="textarea" style={{ minHeight: 70 }} value={form.description} onChange={set('description')} />
          </Field>
          <div className="form-grid">
            <Field label="Probability">
              <select className="select" value={form.probability} onChange={set('probability')}>
                {RISK_LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
              </select>
            </Field>
            <Field label="Impact">
              <select className="select" value={form.impact} onChange={set('impact')}>
                {RISK_LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select className="select" value={form.status} onChange={set('status')}>
                {RISK_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="Owner">
              <select className="select" value={form.owner_id} onChange={set('owner_id')}>
                <option value="">No owner</option>
                {project.members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select>
            </Field>
            <Field label="Review date" hint="You are reminded when it is due">
              <input className="input" type="date" value={form.review_date} onChange={set('review_date')} />
            </Field>
          </div>
          <Field label="Mitigation plan">
            <textarea className="textarea" style={{ minHeight: 70 }} value={form.mitigation} onChange={set('mitigation')} placeholder="How you will reduce the chance or the damage" />
          </Field>
        </div>
        <div className="modal-footer">
          {risk && <button type="button" className="btn btn-ghost danger-text" style={{ marginRight: 'auto' }} onClick={remove}><Trash2 size={14} /> Remove</button>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !form.title.trim()}>{busy ? <Spinner /> : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

export function Risks({ project, risks }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const [editing, setEditing] = useState(null) // null | 'new' | risk
  const active = risks.filter((r) => r.status !== 'closed')

  const setStatus = async (risk, status) => {
    try {
      await api(`/risks/${risk.id}`, { method: 'PATCH', body: { status } })
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="pipeline grow">
          {RISK_LEVELS.slice().reverse().map((l) => (
            <span className="pipe" key={l.key} style={{ '--c': l.color, cursor: 'default' }}>
              <i /> {l.label} <b>{active.filter((r) => r.severity === l.key).length}</b>
            </span>
          ))}
          <span className="small muted" style={{ alignSelf: 'center' }}>open risks by severity (probability × impact)</span>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> Log risk</button>
      </div>

      {risks.length === 0 ? (
        <div className="card">
          <Empty icon={ShieldAlert} title="No risks logged">
            Record anything that could delay or damage the project, who owns it and how you will deal with it. High risks mark the project as “At risk”.
          </Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr><th>Risk</th><th>Severity</th><th>Probability</th><th>Impact</th><th>Owner</th><th>Review</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {risks.map((r) => {
                const sev = byKey(RISK_LEVELS, r.severity)
                return (
                  <tr key={r.id} style={r.status === 'closed' ? { opacity: 0.55 } : undefined}>
                    <td>
                      <button className="feature-title truncate" style={{ maxWidth: 340, display: 'block' }} onClick={() => setEditing(r)}>{r.title}</button>
                      {r.mitigation && <div className="faint small truncate" style={{ maxWidth: 340 }}>Mitigation: {r.mitigation}</div>}
                    </td>
                    <td><Badge color={sev.color}>{sev.label}</Badge></td>
                    <td>{byKey(RISK_LEVELS, r.probability).label}</td>
                    <td>{byKey(RISK_LEVELS, r.impact).label}</td>
                    <td>{r.owner ? <span className="row" style={{ gap: 8 }}><Avatar user={r.owner} size={22} /> {r.owner.full_name}</span> : <span className="faint">—</span>}</td>
                    <td>
                      {r.review_date ? (
                        <span className={`due ${isOverdue(r.review_date, r.status === 'closed') ? 'overdue' : ''}`}><CalendarDays size={12} /> {formatDate(r.review_date)}</span>
                      ) : <span className="faint">—</span>}
                    </td>
                    <td>
                      <select className="select stage-select" style={{ '--c': byKey(RISK_STATUSES, r.status).color, width: 130 }} value={r.status} onChange={(e) => setStatus(r, e.target.value)} aria-label={`Status of ${r.title}`}>
                        {RISK_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                      </select>
                    </td>
                    <td><button className="btn btn-ghost btn-sm btn-icon" onClick={() => setEditing(r)} aria-label={`Edit ${r.title}`}><Pencil size={14} /></button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && <RiskModal project={project} risk={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

/* ───────────── Reports ───────────── */

const hours = (n) => `${Math.round(n * 10) / 10}h`
const isoDay = (stamp) => (stamp ? parseDay(stamp.slice(0, 10)) : null)

function LineChart({ series, labels, height = 190 }) {
  const width = 640
  const pad = { l: 34, r: 10, t: 10, b: 24 }
  const max = Math.max(1, ...series.flatMap((s) => s.values.filter((v) => v != null)))
  const count = labels.length
  const x = (n) => pad.l + (count > 1 ? (n / (count - 1)) * (width - pad.l - pad.r) : 0)
  const y = (v) => pad.t + (1 - v / max) * (height - pad.t - pad.b)
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f))
  const step = Math.max(1, Math.ceil(count / 7))
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="line-chart" role="img" aria-label="Burndown chart">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="grid" />
          <text x={pad.l - 6} y={y(t) + 4} textAnchor="end">{t}</text>
        </g>
      ))}
      {labels.map((label, n) => (n % step === 0 ? <text key={n} x={x(n)} y={height - 6} textAnchor="middle">{label}</text> : null))}
      {series.map((s) => {
        const points = s.values.map((v, n) => (v == null ? null : `${x(n)},${y(v)}`)).filter(Boolean).join(' ')
        return <polyline key={s.name} points={points} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.5 : 2.5} strokeDasharray={s.dashed ? '5 5' : undefined} strokeLinejoin="round" />
      })}
    </svg>
  )
}

export function Reports({ project, issues, features, milestones, risks }) {
  const today = todayDay()

  const burndown = useMemo(() => {
    const created = issues.map((i) => isoDay(i.created_at))
    const first = Math.min(today, parseDay(project.start_date) ?? today, ...created)
    const start = Math.max(first, today - 59)
    const due = parseDay(project.due_date)
    const end = due != null && due > today ? Math.min(due, today + 30) : today
    const labels = []
    const actual = []
    for (let day = start; day <= end; day++) {
      const d = dayToDate(day)
      labels.push(`${d.getUTCDate()}/${d.getUTCMonth() + 1}`)
      actual.push(
        day > today
          ? null
          : issues.filter((i) => isoDay(i.created_at) <= day && (isoDay(i.completed_at) == null || isoDay(i.completed_at) > day || i.status !== 'done')).length,
      )
    }
    let ideal = null
    if (due != null && due > start) {
      const startOpen = actual[0] || issues.length
      ideal = labels.map((_, n) => Math.max(0, startOpen * (1 - n / (due - start))))
    }
    return { labels, actual, ideal }
  }, [issues, project.start_date, project.due_date, today])

  const weeks = useMemo(() => {
    const monday = today - ((dayToDate(today).getUTCDay() + 6) % 7)
    return Array.from({ length: 8 }, (_, n) => {
      const start = monday - (7 - n) * 7
      const inWeek = (stamp) => {
        const day = isoDay(stamp)
        return day != null && day >= start && day < start + 7
      }
      return {
        label: formatDate(dayToISO(start)),
        created: issues.filter((i) => inWeek(i.created_at)).length,
        completed: issues.filter((i) => i.status === 'done' && inWeek(i.completed_at)).length,
      }
    })
  }, [issues, today])

  const done = issues.filter((i) => i.status === 'done')
  const open = issues.filter((i) => i.status !== 'done')
  const overdue = open.filter((i) => i.due_date && parseDay(i.due_date) < today)
  const estimate = issues.reduce((s, i) => s + (i.estimate_hours || 0), 0)
  const spent = issues.reduce((s, i) => s + (i.spent_hours || 0), 0)
  const avgVelocity = weeks.slice(-4).reduce((s, w) => s + w.completed, 0) / 4
  const weeksLeft = avgVelocity > 0 ? Math.ceil(open.length / avgVelocity) : null
  const maxWeek = Math.max(1, ...weeks.flatMap((w) => [w.created, w.completed]))

  const people = [...project.members, null].map((m) => {
    const mine = issues.filter((i) => (m ? i.assignee?.id === m.id : !i.assignee))
    return {
      member: m,
      open: mine.filter((i) => i.status !== 'done').length,
      done: mine.filter((i) => i.status === 'done').length,
      overdue: mine.filter((i) => i.status !== 'done' && i.due_date && parseDay(i.due_date) < today).length,
      estimate: mine.reduce((s, i) => s + (i.estimate_hours || 0), 0),
      spent: mine.reduce((s, i) => s + (i.spent_hours || 0), 0),
    }
  }).filter((p) => p.member || p.open + p.done > 0)

  const stamp = dayToISO(today)
  const exportIssues = () =>
    downloadCsv(`${project.key}-issues-${stamp}.csv`, [
      { label: 'Key', value: (i) => i.key },
      { label: 'Title', value: (i) => i.title },
      { label: 'Type', value: (i) => i.type },
      { label: 'Status', value: (i) => i.status_label || byKey(STATUSES, i.status).label },
      { label: 'Priority', value: (i) => byKey(PRIORITIES, i.priority).label },
      { label: 'Assignee', value: (i) => i.assignee?.full_name },
      { label: 'Feature', value: (i) => i.feature_title },
      { label: 'Milestone', value: (i) => i.milestone_name },
      { label: 'Start date', value: (i) => i.start_date },
      { label: 'Due date', value: (i) => i.due_date },
      { label: 'Estimate (h)', value: (i) => i.estimate_hours },
      { label: 'Spent (h)', value: (i) => i.spent_hours },
      { label: 'Labels', value: (i) => i.labels.join(' ') },
      { label: 'Blocked by', value: (i) => i.blocked_by.map((b) => b.key).join(' ') },
      { label: 'Created', value: (i) => i.created_at?.slice(0, 10) },
      { label: 'Completed', value: (i) => i.completed_at?.slice(0, 10) },
    ], issues)
  const exportFeatures = () =>
    downloadCsv(`${project.key}-features-${stamp}.csv`, [
      { label: 'Feature', value: (f) => f.title },
      { label: 'Stage', value: (f) => byKey(FEATURE_STAGES, f.stage).label },
      { label: 'Priority', value: (f) => byKey(PRIORITIES, f.priority).label },
      { label: 'Owner', value: (f) => f.owner?.full_name },
      { label: 'Release', value: (f) => f.release_version },
      { label: 'Start date', value: (f) => f.start_date },
      { label: 'Target date', value: (f) => f.target_date },
      { label: 'Issues', value: (f) => f.issue_count },
      { label: 'Issues done', value: (f) => f.done_count },
      { label: 'Progress %', value: (f) => f.progress },
      { label: 'Description', value: (f) => f.description },
      { label: 'Acceptance criteria', value: (f) => f.acceptance_criteria },
    ], features)
  const exportRisks = () =>
    downloadCsv(`${project.key}-risks-${stamp}.csv`, [
      { label: 'Risk', value: (r) => r.title },
      { label: 'Severity', value: (r) => r.severity },
      { label: 'Probability', value: (r) => r.probability },
      { label: 'Impact', value: (r) => r.impact },
      { label: 'Status', value: (r) => r.status },
      { label: 'Owner', value: (r) => r.owner?.full_name },
      { label: 'Review date', value: (r) => r.review_date },
      { label: 'Description', value: (r) => r.description },
      { label: 'Mitigation', value: (r) => r.mitigation },
    ], risks)

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="toolbar no-print" style={{ marginBottom: 0 }}>
        <span className="muted grow">Status report for {project.name}, generated {formatDate(stamp, true)}.</span>
        <button className="btn btn-sm" onClick={exportIssues} disabled={!issues.length}><Download size={14} /> Issues CSV</button>
        <button className="btn btn-sm" onClick={exportFeatures} disabled={!features.length}><Download size={14} /> Features CSV</button>
        <button className="btn btn-sm" onClick={exportRisks} disabled={!risks.length}><Download size={14} /> Risks CSV</button>
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}><Printer size={14} /> Print / Save as PDF</button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        {[
          ['Completion', `${project.progress}%`, `${done.length} of ${issues.length} issues`],
          ['Open issues', open.length, `${overdue.length} overdue`],
          ['Velocity', `${Math.round(avgVelocity * 10) / 10}/wk`, 'Average of last 4 weeks'],
          ['Forecast', weeksLeft == null ? '—' : `${weeksLeft} wk`, weeksLeft == null ? 'Not enough history' : 'To clear open issues'],
          ['Time', hours(spent), estimate ? `of ${hours(estimate)} estimated` : 'No estimates'],
          ['Features released', `${features.filter((f) => f.stage === 'released').length}/${features.length}`, `${milestones.filter((m) => m.status === 'closed').length}/${milestones.length} milestones closed`],
        ].map(([label, value, hint]) => (
          <div className="card stat" key={label}>
            <div className="stat-top">{label}</div>
            <div className="stat-value">{value}</div>
            <div className="small faint">{hint}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-header">
            <h2>Burndown</h2>
            <span className="row small muted" style={{ gap: 12 }}>
              <span className="legend-item"><i style={{ background: project.color }} />Open issues</span>
              {burndown.ideal && <span className="legend-item"><i style={{ background: 'var(--text-3)' }} />Ideal</span>}
            </span>
          </div>
          <div className="card-body">
            <LineChart
              labels={burndown.labels}
              series={[
                ...(burndown.ideal ? [{ name: 'ideal', values: burndown.ideal, color: 'var(--text-3)', dashed: true }] : []),
                { name: 'actual', values: burndown.actual, color: project.color },
              ]}
            />
            {!burndown.ideal && <p className="small faint">Set a project due date in Settings to see the ideal line.</p>}
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>Weekly throughput</h2>
            <span className="row small muted" style={{ gap: 12 }}>
              <span className="legend-item"><i style={{ background: '#6366f1' }} />Created</span>
              <span className="legend-item"><i style={{ background: '#22c55e' }} />Completed</span>
            </span>
          </div>
          <div className="card-body">
            <div className="bars" style={{ height: 160 }}>
              {weeks.map((w) => (
                <div className="bar-group" key={w.label} title={`Week of ${w.label}: ${w.created} created, ${w.completed} completed`}>
                  <div className="bar-pair">
                    <div className="bar" style={{ height: `${(w.created / maxWeek) * 100}%`, background: '#6366f1', maxWidth: 18 }} />
                    <div className="bar" style={{ height: `${(w.completed / maxWeek) * 100}%`, background: '#22c55e', maxWidth: 18 }} />
                  </div>
                  <span className="bar-label">{w.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="card table-wrap">
          <div className="card-header" style={{ paddingBottom: 8 }}><h2>By person</h2></div>
          <table className="table">
            <thead><tr><th>Person</th><th>Open</th><th>Done</th><th>Overdue</th><th>Estimate</th><th>Spent</th></tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.member?.id ?? 'none'}>
                  <td>{p.member ? <span className="row" style={{ gap: 8 }}><Avatar user={p.member} size={22} /> {p.member.full_name}</span> : <span className="muted">Unassigned</span>}</td>
                  <td>{p.open}</td>
                  <td>{p.done}</td>
                  <td className={p.overdue ? 'danger-text' : ''}>{p.overdue}</td>
                  <td>{hours(p.estimate)}</td>
                  <td>{hours(p.spent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card table-wrap">
          <div className="card-header" style={{ paddingBottom: 8 }}><h2>By feature</h2></div>
          {features.length === 0 ? (
            <div className="card-body muted">No features yet.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Feature</th><th>Stage</th><th>Issues</th><th style={{ width: 130 }}>Progress</th></tr></thead>
              <tbody>
                {features.map((f) => (
                  <tr key={f.id}>
                    <td><div className="truncate" style={{ maxWidth: 220, fontWeight: 550 }}>{f.title}</div></td>
                    <td><Badge color={byKey(FEATURE_STAGES, f.stage).color}>{byKey(FEATURE_STAGES, f.stage).label}</Badge></td>
                    <td>{f.done_count}/{f.issue_count}</td>
                    <td><Progress value={f.progress} color={byKey(FEATURE_STAGES, f.stage).color} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
