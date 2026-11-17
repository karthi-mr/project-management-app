import { useState } from 'react'
import { Boxes, CalendarDays, Flag, Pencil, Plus, Trash2 } from 'lucide-react'
import { api, onChanged } from '../../api'
import { useConfirm, useToast } from '../../context'
import { useUndoDelete } from '../../components/useUndo'
import { MILESTONE_STAGES, FEATURE_STAGES, byKey, Badge, Empty, Field, Modal, Progress, Spinner, formatDate, isOverdue } from '../../ui'
import { StageSignoff } from '../../components/ProjectRules'

export function MilestoneModal({ projectId, milestone, onClose, onSaved }) {
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

export function Milestones({ project, milestones, reload }) {
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
              {m.modules?.length > 0 && (
                <div className="row row-wrap" style={{ gap: 5 }}>
                  {m.modules.map((mod) => (
                    <span className="tag module-tag" key={`m${mod.id}`} title={`Module · ${byKey(FEATURE_STAGES, mod.stage).label}`}>
                      <Boxes size={11} /> {mod.name} · {byKey(FEATURE_STAGES, mod.stage).label}
                    </span>
                  ))}
                </div>
              )}
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
