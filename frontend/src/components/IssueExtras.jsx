import { useEffect, useState } from 'react'
import { Clock, Plus, X } from 'lucide-react'
import { api, notifyChanged } from '../api'
import { useAuth, useToast } from '../context'
import { Avatar, Field, Progress, formatDate } from '../ui'

/** Inputs for the project's custom fields. Saves each change straight away. */
export function CustomFields({ fields, values, onSave }) {
  if (!fields?.length) return null
  return fields.map((f) => {
    const value = values?.[String(f.id)]
    const save = (next) => onSave({ [f.id]: next === '' ? null : next })
    if (f.type === 'checkbox') {
      return (
        <label className="check-item" key={f.id} style={{ padding: '4px 0' }}>
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => save(e.target.checked)} />
          <span className="label" style={{ margin: 0 }}>{f.name}</span>
        </label>
      )
    }
    return (
      <Field label={f.name} key={f.id}>
        {f.type === 'select' ? (
          <select className="select" value={value ?? ''} onChange={(e) => save(e.target.value)}>
            <option value="">—</option>
            {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : f.type === 'date' ? (
          <input className="input" type="date" value={value ?? ''} onChange={(e) => save(e.target.value)} />
        ) : (
          <input
            className="input"
            type={f.type === 'number' ? 'number' : 'text'}
            key={String(value ?? '')}
            defaultValue={value ?? ''}
            maxLength={500}
            placeholder="—"
            onBlur={(e) => {
              const next = e.target.value
              if (next !== String(value ?? '')) save(next)
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
          />
        )}
      </Field>
    )
  })
}

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Time entries on an issue: log hours against a day, see who logged what. */
export function TimeLog({ issue, canManage, onChange }) {
  const { user } = useAuth()
  const toast = useToast()
  const [entries, setEntries] = useState(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ day: todayISO(), hours: '', note: '' })

  const load = () => api(`/issues/${issue.id}/time`).then(setEntries).catch(() => setEntries([]))
  useEffect(() => {
    load()
  }, [issue.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault()
    try {
      await api(`/issues/${issue.id}/time`, { method: 'POST', body: { day: form.day, hours: Number(form.hours), note: form.note } })
      setForm({ day: todayISO(), hours: '', note: '' })
      setAdding(false)
      await load()
      onChange()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const remove = async (entry) => {
    try {
      await api(`/time/${entry.id}`, { method: 'DELETE' })
      await load()
      onChange()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const spent = issue.spent_hours || 0
  const estimate = issue.estimate_hours || 0

  return (
    <div>
      <div className="row between" style={{ marginBottom: 6 }}>
        <span className="label">Time logged</span>
        {!adding && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}><Plus size={13} /> Log time</button>}
      </div>
      <div className="row between small" style={{ marginBottom: 5 }}>
        <b>{Math.round(spent * 100) / 100}h</b>
        <span className="muted">{estimate ? `of ${estimate}h estimated` : 'no estimate'}</span>
      </div>
      {estimate > 0 && <Progress value={Math.min(100, (spent / estimate) * 100)} color={spent > estimate ? '#ef4444' : '#22c55e'} />}
      {adding && (
        <form className="stack" style={{ gap: 8, marginTop: 10 }} onSubmit={submit}>
          <div className="form-grid" style={{ gap: 8, gridTemplateColumns: '1fr 80px' }}>
            <input className="input input-sm" type="date" value={form.day} max={todayISO()} onChange={(e) => setForm({ ...form, day: e.target.value })} required aria-label="Day" />
            <input className="input input-sm" type="number" min="0.25" max="24" step="0.25" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} placeholder="Hours" required autoFocus aria-label="Hours" />
          </div>
          <input className="input input-sm" value={form.note} maxLength={300} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="What did you work on? (optional)" />
          <div className="row">
            <button className="btn btn-primary btn-sm" disabled={!(Number(form.hours) > 0)}><Clock size={13} /> Save</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}
      {entries?.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {entries.slice(0, 6).map((t) => (
            <div className="time-row" key={t.id} title={t.note || undefined}>
              <Avatar user={t.user} size={18} />
              <b>{t.hours}h</b>
              <span className="faint">{formatDate(t.day)}</span>
              <span className="truncate grow muted">{t.note}</span>
              {(t.user?.id === user.id || canManage) && (
                <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => remove(t)} aria-label="Remove time entry"><X size={12} /></button>
              )}
            </div>
          ))}
          {entries.length > 6 && <div className="faint small">+{entries.length - 6} earlier entries</div>}
        </div>
      )}
    </div>
  )
}
