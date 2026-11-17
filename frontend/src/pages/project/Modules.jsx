import { useEffect, useState } from 'react'
import { Boxes, Flag, Pencil, Plus, Trash2 } from 'lucide-react'
import { api, notifyChanged, onChanged } from '../../api'
import { useConfirm, useToast } from '../../context'
import { Badge, Empty, FEATURE_STAGES, Field, Modal, Progress, Spinner, byKey, formatDate } from '../../ui'
import { StageSignoff } from '../../components/ProjectRules'

/* Modules: a part of the product made of several features. A milestone holds modules and features.
 * Every stage is signed off; a module moves on when all its features are signed off, and signing
 * off a module signs off its features at that stage. */

function ModuleModal({ project, module, features, milestones, onClose, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState({
    name: module?.name || '', description: module?.description || '', owner_id: module?.owner?.id || '',
    milestone_id: module?.milestone_id || '', start_date: module?.start_date || '', target_date: module?.target_date || '',
    feature_ids: new Set((module?.features || []).map((f) => f.id)),
  })
  const [busy, setBusy] = useState(false)
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })
  const toggle = (id) => {
    const next = new Set(form.feature_ids)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setForm({ ...form, feature_ids: next })
  }
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    const body = {
      name: form.name, description: form.description,
      owner_id: form.owner_id ? Number(form.owner_id) : null,
      milestone_id: form.milestone_id ? Number(form.milestone_id) : null,
      start_date: form.start_date || null, target_date: form.target_date || null,
      feature_ids: [...form.feature_ids],
    }
    try {
      await api(module ? `/modules/${module.id}` : `/projects/${project.id}/modules`, { method: module ? 'PATCH' : 'POST', body })
      toast(module ? 'Module saved' : 'Module added')
      notifyChanged()
      onSaved()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }
  const available = features.filter((f) => !f.module_id || f.module_id === module?.id || form.feature_ids.has(f.id))
  const elsewhere = features.filter((f) => f.module_id && f.module_id !== module?.id && !form.feature_ids.has(f.id))
  return (
    <Modal title={module ? `Edit ${module.name}` : 'New module'} onClose={onClose} size="lg">
      <form onSubmit={submit}>
        <div className="modal-body stack">
          <div className="form-grid">
            <Field label="Module name"><input className="input" value={form.name} onChange={set('name')} maxLength={120} placeholder="e.g. Payments" required autoFocus /></Field>
            <Field label="Owner">
              <select className="select" value={form.owner_id} onChange={set('owner_id')}>
                <option value="">No owner</option>
                {project.members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="What it covers"><textarea className="textarea" rows={2} value={form.description} onChange={set('description')} /></Field>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <Field label="Milestone" hint="Its features become part of this milestone.">
              <select className="select" value={form.milestone_id} onChange={set('milestone_id')}>
                <option value="">No milestone</option>
                {milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
            <Field label="Start date"><input className="input" type="date" value={form.start_date} onChange={set('start_date')} /></Field>
            <Field label="Target date"><input className="input" type="date" value={form.target_date} min={form.start_date || undefined} onChange={set('target_date')} /></Field>
          </div>
          <Field label={`Features (${form.feature_ids.size})`} as="div">
            {features.length === 0 ? <span className="muted small">No features yet. Add features on the Features tab first.</span> : (
              <div className="module-picks">
                {[...available, ...elsewhere].map((f) => (
                  <label key={f.id} className="opt-row">
                    <input type="checkbox" checked={form.feature_ids.has(f.id)} onChange={() => toggle(f.id)} />
                    <span className="grow">{f.title}{f.module_id && f.module_id !== module?.id && !form.feature_ids.has(f.id) ? <span className="faint small"> · now in {f.module_name}</span> : null}</span>
                    <Badge color={byKey(FEATURE_STAGES, f.stage).color}>{byKey(FEATURE_STAGES, f.stage).label}</Badge>
                  </label>
                ))}
              </div>
            )}
          </Field>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? <Spinner /> : module ? 'Save module' : 'Add module'}</button>
        </div>
      </form>
    </Modal>
  )
}

export function Modules({ project, features, milestones, onOpenFeature, reload }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [modules, setModules] = useState(null)
  const [editing, setEditing] = useState(null)
  const load = () => api(`/projects/${project.id}/modules`).then(setModules).catch(() => setModules([]))
  useEffect(() => {
    load()
    return onChanged(load)
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (m) => {
    if (!(await confirm({ title: `Delete the module “${m.name}”?`, message: 'Its features stay, in the same milestone, without a module.', confirmLabel: 'Delete module', danger: true }))) return
    try {
      await api(`/modules/${m.id}`, { method: 'DELETE' })
      toast('Module deleted')
      notifyChanged()
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  if (!modules) return <div className="card card-pad"><Spinner /></div>
  return (
    <>
      <div className="toolbar">
        <span className="muted small grow">
          A module groups features (for example “Payments”). It moves on when all its features are signed off, and signing it off signs off its features at that stage.
        </span>
        {project.can_edit && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> New module</button>}
      </div>
      {modules.length === 0 ? (
        <div className="card">
          <Empty icon={Boxes} title="No modules yet" action={project.can_edit && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> New module</button>}>
            Group related features into a module, and put modules into milestones.
          </Empty>
        </div>
      ) : (
        <div className="grid grid-cards">
          {modules.map((m) => {
            const stage = byKey(FEATURE_STAGES, m.stage)
            return (
              <div className="card card-pad stack module-card" key={m.id} style={{ gap: 10 }}>
                <div className="row between" style={{ gap: 8 }}>
                  <h3 className="truncate icon-label"><Boxes size={16} /> <span>{m.name}</span></h3>
                  <Badge color={stage.color}>{stage.label}</Badge>
                </div>
                <div className="row row-wrap small muted" style={{ gap: 10 }}>
                  {m.milestone_name && <span className="tag"><Flag size={11} /> {m.milestone_name}</span>}
                  {m.owner && <span>Owner: {m.owner.full_name}</span>}
                  {m.target_date && <span>Target {formatDate(m.target_date)}</span>}
                </div>
                {m.description && <p className="muted small" style={{ margin: 0 }}>{m.description}</p>}
                {m.features.length > 0 ? (
                  <div className="row row-wrap" style={{ gap: 5 }}>
                    {m.features.map((f) => (
                      <button type="button" className="tag" key={f.id} onClick={() => onOpenFeature(f.id)} title={`Open feature · ${byKey(FEATURE_STAGES, f.stage).label}`}>
                        <i style={{ width: 6, height: 6, borderRadius: '50%', background: byKey(FEATURE_STAGES, f.stage).color }} /> {f.title} · {byKey(FEATURE_STAGES, f.stage).label}
                      </button>
                    ))}
                  </div>
                ) : <span className="muted small">No features yet. Edit the module to add some.</span>}
                <StageSignoff project={project} type="module" item={m} onChanged={() => { load(); reload() }} dense />
                {m.feature_count > 0 && (
                  <div>
                    <div className="row between small muted" style={{ marginBottom: 6 }}>
                      <span>{m.released_count} of {m.feature_count} features released</span>
                      <b>{Math.round((m.released_count * 100) / m.feature_count)}%</b>
                    </div>
                    <Progress value={(m.released_count * 100) / m.feature_count} color={project.color} />
                  </div>
                )}
                {project.can_edit && (
                  <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(m)}><Pencil size={13} /> Edit</button>
                    {project.can_manage && <button className="btn btn-ghost btn-sm danger-text" onClick={() => remove(m)} aria-label={`Delete ${m.name}`}><Trash2 size={13} /></button>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {editing && (
        <ModuleModal
          project={project}
          module={editing === 'new' ? null : editing}
          features={features}
          milestones={milestones.filter((m) => m.status !== 'closed' || m.id === editing?.milestone_id)}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); reload() }}
        />
      )}
    </>
  )
}
