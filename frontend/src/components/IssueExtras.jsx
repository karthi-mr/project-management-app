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

/** Time on a feature: logged on the feature itself (design, analysis, reviews) plus its issues.
 *  No <form> here, because the feature dialog is already one. */
export function FeatureTimeLog({ feature, canManage }) {
  const { user } = useAuth()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ day: todayISO(), hours: '', note: '' })

  const load = () => api(`/features/${feature.id}/time`).then(setData).catch(() => setData(false))
  useEffect(() => {
    load()
  }, [feature.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!(Number(form.hours) > 0)) return
    try {
      await api(`/features/${feature.id}/time`, { method: 'POST', body: { day: form.day, hours: Number(form.hours), note: form.note } })
      setForm({ day: todayISO(), hours: '', note: '' })
      setAdding(false)
      await load()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const remove = async (entry) => {
    try {
      await api(`/time/${entry.id}`, { method: 'DELETE' })
      await load()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const enter = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      save()
    }
  }

  if (data === false) return null
  if (!data) return null
  const money = (v) => {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: data.currency, maximumFractionDigits: 0 }).format(v)
    } catch {
      return `${data.currency} ${v}`
    }
  }
  return (
    <div className="feature-time">
      <div className="row between" style={{ marginBottom: 6 }}>
        <div className="section-title" style={{ margin: 0 }}>Time and cost</div>
        {!adding && <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}><Plus size={14} /> Log time on this feature</button>}
      </div>
      <div className="feature-time-sum">
        <div><b>{data.total_hours}h</b><span>in total</span></div>
        <div><b>{data.direct_hours}h</b><span>on the feature</span></div>
        <div><b>{data.issue_hours}h</b><span>on its issues</span></div>
        {data.cost != null && <div><b>{money(data.cost)}</b><span>cost{data.unpriced_hours > 0 ? ` (${data.unpriced_hours}h unpriced)` : ''}</span></div>}
      </div>
      {adding && (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          <div className="form-grid" style={{ gap: 8, gridTemplateColumns: '160px 90px 1fr' }}>
            <input className="input input-sm" type="date" value={form.day} max={todayISO()} onChange={(e) => setForm({ ...form, day: e.target.value })} aria-label="Day" onKeyDown={enter} />
            <input className="input input-sm" type="number" min="0.25" max="24" step="0.25" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} placeholder="Hours" autoFocus aria-label="Hours" onKeyDown={enter} />
            <input className="input input-sm" value={form.note} maxLength={300} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="What did you work on? e.g. design review" aria-label="Note" onKeyDown={enter} />
          </div>
          <div className="row">
            <button type="button" className="btn btn-primary btn-sm" disabled={!(Number(form.hours) > 0)} onClick={save}><Clock size={13} /> Save time</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
      {data.entries.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {data.entries.slice(0, 8).map((t) => (
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
          {data.entries.length > 8 && <div className="faint small">+{data.entries.length - 8} earlier entries</div>}
        </div>
      )}
    </div>
  )
}
