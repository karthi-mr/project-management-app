import { useEffect, useState } from 'react'
import { api, notifyChanged } from '../api'
import { useToast } from '../context'
import { Field, Modal, PRIORITIES, RECURRENCES, Spinner, TYPES, statusesOf } from '../ui'
import { RichEditor } from './RichText'

export default function IssueForm({ projects, defaultProjectId, defaultStatus = 'todo', defaultFeatureId, onClose }) {
  const toast = useToast()
  const selectable = projects.filter((p) => p.status !== 'archived')
  const [form, setForm] = useState({
    project_id: defaultProjectId || selectable[0]?.id || '',
    title: '',
    description: '',
    type: 'task',
    status: defaultStatus,
    priority: 'medium',
    assignee_id: '',
    milestone_id: '',
    feature_id: defaultFeatureId || '',
    start_date: '',
    due_date: '',
    estimate_hours: '',
    labels: '',
    recurrence: '',
    sprint_id: '',
  })
  const [milestones, setMilestones] = useState([])
  const [features, setFeatures] = useState([])
  const [sprints, setSprints] = useState([])
  const [templates, setTemplates] = useState([])
  const [templateId, setTemplateId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const project = projects.find((p) => p.id === Number(form.project_id))
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }))

  useEffect(() => {
    if (!form.project_id) return
    const sections = projects.find((p) => p.id === Number(form.project_id))?.sections || []
    setMilestones([])
    if (sections.includes('milestones')) {
      api(`/projects/${form.project_id}/milestones`)
        .then((rows) => setMilestones(rows.filter((m) => m.status === 'open')))
        .catch(() => {})
    }
    setSprints([])
    setTemplates([])
    setTemplateId('')
    if (sections.includes('issues')) {
      api(`/projects/${form.project_id}/sprints`).then((rows) => setSprints(rows.filter((s) => s.status !== 'completed'))).catch(() => {})
      api(`/projects/${form.project_id}/issue-templates`).then(setTemplates).catch(() => {})
    }
    setFeatures([])
    if (sections.includes('features')) {
      api(`/projects/${form.project_id}/features`)
        .then((rows) => setFeatures(rows.filter((f) => f.stage !== 'released' || f.id === Number(defaultFeatureId))))
        .catch(() => {})
    }
  }, [form.project_id]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const issue = await api('/issues', {
        method: 'POST',
        body: {
          project_id: Number(form.project_id),
          title: form.title,
          description: form.description,
          type: form.type,
          status: statusesOf(project).some((s) => s.key === form.status) ? form.status : null,
          priority: form.priority,
          assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
          milestone_id: form.milestone_id ? Number(form.milestone_id) : null,
          feature_id: form.feature_id ? Number(form.feature_id) : null,
          sprint_id: form.sprint_id ? Number(form.sprint_id) : null,
          checklist: templates.find((t) => t.id === Number(templateId))?.checklist || [],
          start_date: form.start_date || null,
          due_date: form.due_date || null,
          estimate_hours: form.estimate_hours === '' ? null : Number(form.estimate_hours),
          recurrence: form.recurrence,
          labels: form.labels.split(',').map((l) => l.trim()).filter(Boolean),
        },
      })
      toast(`${issue.key} created`)
      notifyChanged()
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <Modal title="New issue" onClose={onClose} size="md">
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}
          <Field label="Project">
            <select
              className="select"
              value={form.project_id}
              onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value, assignee_id: '', milestone_id: '', feature_id: '', status: statusesOf(projects.find((p) => p.id === Number(e.target.value))).some((s) => s.key === f.status) ? f.status : statusesOf(projects.find((p) => p.id === Number(e.target.value)))[0].key }))}
              required
            >
              {selectable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.key} · {p.name}
                </option>
              ))}
            </select>
          </Field>
          {templates.length > 0 && (
            <Field label="Start from a template" hint={templateId ? 'Fills the title, description, type, priority, labels and checklist' : undefined}>
              <select
                className="select"
                value={templateId}
                onChange={(e) => {
                  setTemplateId(e.target.value)
                  const t = templates.find((x) => x.id === Number(e.target.value))
                  if (t) {
                    setForm((f) => ({
                      ...f,
                      title: f.title || t.title,
                      description: t.description,
                      type: t.type,
                      priority: t.priority,
                      labels: t.labels.join(', '),
                    }))
                  }
                }}
              >
                <option value="">Blank issue</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Title">
            <input className="input" value={form.title} onChange={set('title')} maxLength={200} placeholder="What needs to be done?" autoFocus required />
          </Field>
          <Field label="Description" as="div">
            <RichEditor value={form.description} onChange={(description) => setForm((f) => ({ ...f, description }))} members={project?.members} minHeight={110} placeholder="Add details, steps to reproduce, acceptance criteria… Paste screenshots straight in." />
          </Field>
          {features.length > 0 && (
            <Field label="Feature" hint="The feature this work belongs to">
              <select className="select" value={form.feature_id} onChange={set('feature_id')}>
                <option value="">None</option>
                {features.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
              </select>
            </Field>
          )}
          <div className="form-grid">
            <Field label="Type">
              <select className="select" value={form.type} onChange={set('type')}>
                {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Priority">
              <select className="select" value={form.priority} onChange={set('priority')}>
                {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select className="select" value={form.status} onChange={set('status')}>
                {statusesOf(project).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="Assignee">
              <select className="select" value={form.assignee_id} onChange={set('assignee_id')}>
                <option value="">Unassigned</option>
                {(project?.members || []).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select>
            </Field>
            <Field label="Start date">
              <input className="input" type="date" value={form.start_date} onChange={set('start_date')} />
            </Field>
            <Field label="Due date">
              <input className="input" type="date" value={form.due_date} min={form.start_date || undefined} onChange={set('due_date')} />
            </Field>
            <Field label="Estimate (hours)">
              <input className="input" type="number" min="0" step="0.5" value={form.estimate_hours} onChange={set('estimate_hours')} placeholder="—" />
            </Field>
            {sprints.length > 0 && (
              <Field label="Sprint">
                <select className="select" value={form.sprint_id} onChange={set('sprint_id')}>
                  <option value="">Backlog (no sprint)</option>
                  {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'active' ? ' (active)' : ''}</option>)}
                </select>
              </Field>
            )}
            <Field label="Milestone">
              <select className="select" value={form.milestone_id} onChange={set('milestone_id')}>
                <option value="">None</option>
                {milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
            <Field label="Repeats" hint="Next one is created when this is done">
              <select className="select" value={form.recurrence} onChange={set('recurrence')}>
                {RECURRENCES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
            </Field>
            <Field label="Labels" hint="Comma separated">
              <input className="input" value={form.labels} onChange={set('labels')} placeholder="frontend, api" />
            </Field>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !form.title.trim()}>
            {busy ? <Spinner /> : 'Create issue'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
