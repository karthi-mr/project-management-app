import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Camera, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { api, notifyChanged, uploadImage } from '../api'
import { useConfirm, useToast } from '../context'
import { Field, ProjectIcon, Spinner, statusesOf } from '../ui'

/* ───────────── Logo ───────────── */

export function LogoCard({ project, reload }) {
  const toast = useToast()
  const input = useRef(null)
  const [busy, setBusy] = useState(false)

  const setLogo = async (url) => {
    await api(`/projects/${project.id}`, { method: 'PATCH', body: { logo_url: url } })
    reload()
    notifyChanged()
  }

  const upload = async (file) => {
    if (!file) return
    setBusy(true)
    try {
      await setLogo(await uploadImage(file))
      toast('Logo updated')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    try {
      await setLogo(null)
      toast('Logo removed')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div className="card card-pad stack">
      <h2>Logo</h2>
      <div className="photo-edit">
        <ProjectIcon project={project} size={64} />
        <div className="stack" style={{ gap: 8 }}>
          <div className="row row-wrap">
            <button type="button" className="btn" onClick={() => input.current?.click()} disabled={busy}>
              {busy ? <Spinner /> : <Camera size={15} />} {project.logo_url ? 'Change logo' : 'Upload logo'}
            </button>
            {project.logo_url && <button type="button" className="btn btn-ghost danger-text" onClick={remove}><Trash2 size={14} /> Remove</button>}
          </div>
          <span className="hint">Shown on project cards, search and the roadmap. Without a logo the project key is shown on its colour.</span>
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { upload(e.target.files[0]); e.target.value = '' }} />
      </div>
    </div>
  )
}

/* ───────────── Workflow ───────────── */

const NEW_COLORS = ['#06b6d4', '#ec4899', '#84cc16', '#f97316', '#8b5cf6', '#14b8a6', '#eab308']

export function WorkflowCard({ project, issues, reload }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [rows, setRows] = useState(() => statusesOf(project).map((s) => ({ ...s })))
  const [busy, setBusy] = useState(false)

  const done = rows.find((r) => r.key === 'done')
  const editable = rows.filter((r) => r.key !== 'done')
  const set = (index, changes) => setRows((list) => list.map((r, n) => (n === index ? { ...r, ...changes } : r)))
  const move = (index, delta) =>
    setRows((list) => {
      const next = [...list]
      ;[next[index], next[index + delta]] = [next[index + delta], next[index]]
      return next
    })
  const add = () =>
    setRows((list) => [
      ...list.filter((r) => r.key !== 'done'),
      { key: null, label: '', color: NEW_COLORS[list.length % NEW_COLORS.length] },
      ...list.filter((r) => r.key === 'done'),
    ])

  const save = async () => {
    const removed = statusesOf(project).filter((s) => !rows.some((r) => r.key === s.key))
    const affected = issues.filter((i) => removed.some((s) => s.key === i.status)).length
    if (affected) {
      const ok = await confirm({
        title: `Remove ${removed.map((s) => s.label).join(', ')}?`,
        message: `${affected} issue(s) in ${removed.length === 1 ? 'that status' : 'those statuses'} will move to “${editable[0]?.label || 'the first status'}”.`,
        confirmLabel: 'Save workflow',
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const result = await api(`/projects/${project.id}/workflow`, {
        method: 'PUT',
        body: { statuses: rows.map((r) => ({ key: r.key || undefined, label: r.label.trim(), color: r.color })) },
      })
      setRows(result.statuses.map((s) => ({ ...s })))
      toast(result.moved ? `Workflow saved; ${result.moved} issue(s) moved` : 'Workflow saved')
      reload()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    const ok = await confirm({
      title: 'Reset to the standard workflow?',
      message: 'Backlog, To do, In progress, In review, Done. Issues in custom statuses move to To do.',
      confirmLabel: 'Reset',
    })
    if (!ok) return
    try {
      const result = await api(`/projects/${project.id}/workflow`, { method: 'DELETE' })
      setRows(result.statuses.map((s) => ({ ...s })))
      toast('Workflow reset')
      reload()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const valid = rows.every((r) => r.label.trim()) && new Set(rows.map((r) => r.label.trim().toLowerCase())).size === rows.length

  return (
    <div className="card card-pad stack">
      <div>
        <h2>Issue workflow</h2>
        <p className="muted small">The columns of the board and the statuses an issue can be in. The last status always means the work is finished.</p>
      </div>
      <div>
        {rows.map((row, index) => {
          const isDone = row.key === 'done'
          return (
            <div className="wf-row" key={row.key || `new-${index}`}>
              <input type="color" value={row.color} onChange={(e) => set(index, { color: e.target.value })} aria-label={`Colour for ${row.label || 'new status'}`} />
              <input className="input grow" value={row.label} maxLength={30} placeholder="Status name" onChange={(e) => set(index, { label: e.target.value })} aria-label="Status name" />
              {isDone ? (
                <span className="faint small" style={{ width: 96, textAlign: 'right' }}>Finished</span>
              ) : (
                <span className="row" style={{ gap: 0 }}>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up"><ArrowUp size={14} /></button>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" disabled={index >= editable.length - 1} onClick={() => move(index, 1)} aria-label="Move down"><ArrowDown size={14} /></button>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm danger-text" disabled={editable.length <= 1} onClick={() => setRows((list) => list.filter((_, n) => n !== index))} aria-label={`Remove ${row.label}`}><X size={14} /></button>
                </span>
              )}
            </div>
          )
        })}
      </div>
      <div className="row row-wrap">
        <button type="button" className="btn btn-sm" onClick={add} disabled={rows.length >= 12}><Plus size={14} /> Add status</button>
        <span className="grow" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={reset}><RotateCcw size={13} /> Reset to default</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !valid || !done}>{busy ? <Spinner /> : 'Save workflow'}</button>
      </div>
    </div>
  )
}

/* ───────────── Custom fields ───────────── */

const FIELD_TYPES = [
  { key: 'text', label: 'Text' },
  { key: 'number', label: 'Number' },
  { key: 'date', label: 'Date' },
  { key: 'select', label: 'Choice list' },
  { key: 'checkbox', label: 'Yes / no' },
]

export function FieldsCard({ project, reload }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [form, setForm] = useState({ name: '', type: 'text', options: '' })
  const [busy, setBusy] = useState(false)

  const add = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/projects/${project.id}/fields`, {
        method: 'POST',
        body: { name: form.name, type: form.type, options: form.options.split(',').map((o) => o.trim()).filter(Boolean) },
      })
      setForm({ name: '', type: 'text', options: '' })
      toast('Field added')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (field) => {
    const ok = await confirm({ title: `Delete the “${field.name}” field?`, message: 'Its value is removed from every issue in this project.', confirmLabel: 'Delete field', danger: true })
    if (!ok) return
    try {
      await api(`/fields/${field.id}`, { method: 'DELETE' })
      toast('Field deleted')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div className="card card-pad stack">
      <div>
        <h2>Custom issue fields</h2>
        <p className="muted small">Extra information every issue in this project can record, such as a customer, story points or environment.</p>
      </div>
      {project.fields.length > 0 && (
        <div>
          {project.fields.map((f) => (
            <div className="wf-row" key={f.id} style={{ borderTop: '1px solid var(--border)' }}>
              <b className="grow">{f.name}</b>
              <span className="tag">{FIELD_TYPES.find((t) => t.key === f.type)?.label}</span>
              {f.type === 'select' && <span className="faint small truncate" style={{ maxWidth: 220 }}>{f.options.join(', ')}</span>}
              <button className="btn btn-ghost btn-icon btn-sm danger-text" onClick={() => remove(f)} aria-label={`Delete ${f.name}`}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
      <form className="form-grid" style={{ gridTemplateColumns: '1fr 150px auto', alignItems: 'end' }} onSubmit={add}>
        <Field label="Field name">
          <input className="input" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Customer" />
        </Field>
        <Field label="Type">
          <select className="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {FIELD_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </Field>
        <button className="btn btn-primary" disabled={busy || !form.name.trim() || (form.type === 'select' && !form.options.trim())}><Plus size={15} /> Add</button>
        {form.type === 'select' && (
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Choices" hint="Separate with commas">
              <input className="input" value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} placeholder="Production, Staging, Development" />
            </Field>
          </div>
        )}
      </form>
    </div>
  )
}
