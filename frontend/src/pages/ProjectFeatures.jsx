import { useEffect, useState } from 'react'
import { Boxes, CalendarDays, Columns3, Flag, Layers, List, Pencil, Plus, Rocket, Search, Stamp, Trash2 } from 'lucide-react'
import { api, notifyChanged } from '../api'
import { useAuth, useConfirm, useToast } from '../context'
import { useUndoDelete } from '../components/useUndo'
import {
  Avatar,
  Badge,
  ENVIRONMENTS,
  Empty,
  FEATURE_STAGES,
  Field,
  Modal,
  PRIORITIES,
  PriorityIcon,
  Progress,
  RELEASE_STATUSES,
  Spinner,
  StatusBadge,
  TypeIcon,
  byKey,
  formatDate,
  isOverdue,
  useOpenIssue,
} from '../ui'
import IssueForm from '../components/IssueForm'
import { FeatureTimeLog } from '../components/IssueExtras'
import { ApprovalBadge, RequestApprovalModal, StageSignoff, WatchButton } from '../components/ProjectRules'

/* ───────────── Feature modal (create + edit) ───────────── */

export function FeatureModal({ project, featureId, releases, onClose }) {
  const { user } = useAuth()
  const toast = useToast()
  const undo = useUndoDelete()
  const confirm = useConfirm()
  const openIssue = useOpenIssue()
  const isNew = !featureId
  const [feature, setFeature] = useState(null)
  const [form, setForm] = useState({
    title: '', description: '', acceptance_criteria: '', stage: 'planned', priority: 'medium',
    owner_id: '', release_id: '', milestone_id: '', module_id: '', start_date: '', target_date: '',
  })
  const [milestones, setMilestones] = useState([])
  const [modules, setModules] = useState([])
  useEffect(() => {
    if (project.sections.includes('milestones')) api(`/projects/${project.id}/milestones`).then(setMilestones).catch(() => {})
    api(`/projects/${project.id}/modules`).then(setModules).catch(() => {})
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // A feature in a module is part of the module's milestone.
  const inModule = modules.find((m) => m.id === Number(form.module_id))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [addingIssue, setAddingIssue] = useState(false)
  const [asking, setAsking] = useState(false)
  const [approvals, setApprovals] = useState([])
  useEffect(() => {
    if (featureId) api(`/projects/${project.id}/approvals`).then(setApprovals).catch(() => {})
  }, [featureId, project.id, asking])
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }))

  const load = () =>
    api(`/features/${featureId}`)
      .then((data) => {
        setFeature(data)
        return data
      })
      .catch((err) => setError(err.message))

  useEffect(() => {
    if (isNew) return
    load().then((data) => {
      if (!data?.id) return
      setForm({
        title: data.title,
        description: data.description,
        acceptance_criteria: data.acceptance_criteria,
        stage: data.stage,
        priority: data.priority,
        owner_id: data.owner?.id || '',
        release_id: data.release_id || '',
        milestone_id: data.milestone_id || '',
        module_id: data.module_id || '',
        start_date: data.start_date || '',
        target_date: data.target_date || '',
      })
    })
    // Reload the linked issues when one is created or changed elsewhere.
    const onChange = () => load()
    window.addEventListener('pm:changed', onChange)
    return () => window.removeEventListener('pm:changed', onChange)
  }, [featureId]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    const body = {
      ...form,
      owner_id: form.owner_id ? Number(form.owner_id) : null,
      release_id: form.release_id ? Number(form.release_id) : null,
      milestone_id: form.milestone_id ? Number(form.milestone_id) : null,
      module_id: form.module_id ? Number(form.module_id) : null,
      start_date: form.start_date || null,
      target_date: form.target_date || null,
    }
    if (inModule) delete body.milestone_id // it comes from the module
    // With sign-offs on, the stage only changes through a sign-off, never by saving this form.
    if (!isNew && project.signoff_gated) delete body.stage
    try {
      if (isNew) await api(`/projects/${project.id}/features`, { method: 'POST', body })
      else await api(`/features/${featureId}`, { method: 'PATCH', body })
      toast(isNew ? 'Feature added' : 'Feature saved')
      notifyChanged()
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const remove = async () => {
    const ok = await confirm({
      title: `Delete feature “${feature.title}”?`,
      message: 'It moves to the recycle bin for 30 days. Its issues stay, without the feature link until it is restored.',
      confirmLabel: 'Delete feature',
      danger: true,
    })
    if (!ok) return
    try {
      await api(`/features/${featureId}`, { method: 'DELETE' })
      undo('feature', featureId, `Feature “${feature.title}”`)
      notifyChanged()
      onClose()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  if (!isNew && !feature) {
    return (
      <Modal title={error ? 'Feature unavailable' : 'Loading…'} onClose={onClose} size="sm">
        {error ? <div className="modal-body"><p className="muted">{error}</p></div> : <Spinner page />}
      </Modal>
    )
  }

  const canDelete = !isNew && (project.can_manage || feature.owner?.id === user.id)

  return (
    <>
      <Modal title={isNew ? 'New feature' : 'Feature'} onClose={onClose} size={isNew ? 'md' : 'lg'}>
        <form onSubmit={submit}>
          <div className="modal-body">
            {error && <div className="form-error">{error}</div>}
            {!isNew && feature && <StageSignoff project={project} type="feature" item={feature} onChanged={load} />}
            <Field label="Feature name">
              <input className="input" value={form.title} onChange={set('title')} maxLength={200} placeholder="e.g. Online checkout" autoFocus={isNew} required />
            </Field>
            <div className="form-grid">
              <Field label="What it does and why">
                <textarea className="textarea" style={{ minHeight: 110 }} value={form.description} onChange={set('description')} placeholder="Describe the feature and the problem it solves…" />
              </Field>
              <Field label="Acceptance criteria" hint="How you will know it is finished">
                <textarea className="textarea" style={{ minHeight: 110 }} value={form.acceptance_criteria} onChange={set('acceptance_criteria')} placeholder={'- User can pay by card\n- Order confirmation email is sent'} />
              </Field>
            </div>
            <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
              <Field label="Stage" hint={project.signoff_gated ? (isNew ? 'Later stages are reached by sign-off.' : 'Changes by sign-off, one stage at a time.') : undefined}>
                <select className="select" value={form.stage} onChange={set('stage')} disabled={project.signoff_gated && !isNew}>
                  {FEATURE_STAGES.filter((s, n) => !project.signoff_gated || !isNew || project.can_approve || n < 2).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </Field>
              <Field label="Priority">
                <select className="select" value={form.priority} onChange={set('priority')}>
                  {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </Field>
              <Field label="Owner">
                <select className="select" value={form.owner_id} onChange={set('owner_id')}>
                  <option value="">No owner</option>
                  {project.members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                </select>
              </Field>
              <Field label="Release">
                <select className="select" value={form.release_id} onChange={set('release_id')}>
                  <option value="">Not scheduled</option>
                  {releases.map((r) => <option key={r.id} value={r.id}>{r.version} ({byKey(ENVIRONMENTS, r.environment).label})</option>)}
                </select>
              </Field>
              <Field label="Module" hint={project.signoff_gated ? 'The module moves on when all its features are signed off.' : undefined}>
                <select className="select" value={form.module_id} onChange={set('module_id')}>
                  <option value="">No module</option>
                  {modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </Field>
              <Field label="Milestone" hint={inModule ? `Comes from the module “${inModule.name}”.` : project.signoff_gated ? 'The milestone moves on when all its features are signed off.' : undefined}>
                <select className="select" value={inModule ? (inModule.milestone_id || '') : form.milestone_id} onChange={set('milestone_id')} disabled={Boolean(inModule)}>
                  <option value="">No milestone</option>
                  {milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </Field>
              <Field label="Start date">
                <input className="input" type="date" value={form.start_date} onChange={set('start_date')} />
              </Field>
              <Field label="Target date">
                <input className="input" type="date" value={form.target_date} min={form.start_date || undefined} onChange={set('target_date')} />
              </Field>
            </div>

            {!isNew && (
              <div className="row row-wrap" style={{ gap: 8 }}>
                <WatchButton kind="feature" id={feature.id} />
                {!project.signoff_gated && !approvals.some((a) => a.kind === 'feature' && a.target_id === feature.id && ['pending', 'approved'].includes(a.status)) && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAsking(true)}><Stamp size={14} /> Request approval</button>
                )}
                {!project.signoff_gated && approvals.filter((a) => a.kind === 'feature' && a.target_id === feature.id).slice(0, 1).map((a) => (
                  <span key={a.id} className="small muted row" style={{ gap: 6 }}>Latest sign-off: <ApprovalBadge approval={a} /> {a.approver?.full_name}</span>
                ))}
              </div>
            )}
            {!isNew && (
              <div>
                <div className="row between" style={{ marginBottom: 8 }}>
                  <div className="section-title" style={{ margin: 0 }}>
                    Issues · {feature.done_count} of {feature.issue_count} done
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => setAddingIssue(true)}><Plus size={14} /> Add issue</button>
                </div>
                {feature.issue_count > 0 && <Progress value={feature.progress} color={project.color} />}
                {feature.issues.length === 0 ? (
                  <p className="muted small" style={{ marginTop: 8 }}>No issues yet. Break this feature down into tasks and bugs to track the work.</p>
                ) : (
                  <div className="card" style={{ marginTop: 10, boxShadow: 'none' }}>
                    {feature.issues.map((i) => (
                      <button type="button" className="list-row" key={i.id} style={{ padding: '8px 12px' }} onClick={() => openIssue(i.id)}>
                        <TypeIcon type={i.type} />
                        <span className="issue-key">{i.key}</span>
                        <span className="truncate grow" style={i.status === 'done' ? { textDecoration: 'line-through', opacity: 0.6 } : { fontWeight: 550 }}>{i.title}</span>
                        <Avatar user={i.assignee} size={20} />
                        <StatusBadge issue={i} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!isNew && user.org?.features?.includes('time_tracking') && user.org?.modules?.time !== false && (
              <FeatureTimeLog feature={feature} canManage={project.can_manage} />
            )}
          </div>
          <div className="modal-footer">
            {canDelete && (
              <button type="button" className="btn btn-ghost danger-text" style={{ marginRight: 'auto' }} onClick={remove}><Trash2 size={14} /> Delete</button>
            )}
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !form.title.trim()}>{busy ? <Spinner /> : isNew ? 'Add feature' : 'Save changes'}</button>
          </div>
        </form>
      </Modal>
      {asking && <RequestApprovalModal project={project} kind="feature" targetId={feature.id} defaultTitle={`Approve feature “${feature.title}”`} onClose={() => setAsking(false)} />}
      {addingIssue && (
        <IssueForm projects={[project]} defaultProjectId={project.id} defaultFeatureId={feature.id} onClose={() => setAddingIssue(false)} />
      )}
    </>
  )
}

/* ───────────── Features tab ───────────── */

export function Features({ project, features, onOpen, onCreate }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const [stage, setStage] = useState('')
  const [query, setQuery] = useState('')
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem('pm_feature_view') === 'board' ? 'board' : 'list'
    } catch {
      return 'list'
    }
  })
  const [dragId, setDragId] = useState(null)
  const [overStage, setOverStage] = useState(null)

  const changeView = (next) => {
    setView(next)
    try {
      localStorage.setItem('pm_feature_view', next)
    } catch {
      /* ignore */
    }
  }

  const setFeatureStage = async (feature, next) => {
    try {
      await api(`/features/${feature.id}`, { method: 'PATCH', body: { stage: next } })
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  if (features.length === 0) {
    return (
      <div className="card">
        <Empty icon={Layers} title="Plan what you are going to build" action={<button className="btn btn-primary" onClick={onCreate}><Plus size={16} /> New feature</button>}>
          Features are the things this project delivers. List them here, move each one from Proposed through Development and Testing to Released,
          and link issues to them to track the actual work.
        </Empty>
      </div>
    )
  }

  const term = query.trim().toLowerCase()
  const matched = term
    ? features.filter((f) =>
        `${f.title} ${f.description} ${f.acceptance_criteria} ${f.owner?.full_name || ''} ${f.release_version || ''}`.toLowerCase().includes(term))
    : features
  const shown = stage ? matched.filter((f) => f.stage === stage) : matched
  const released = features.filter((f) => f.stage === 'released').length

  return (
    <>
      <div className="toolbar">
        <div className="input-icon">
          <Search size={15} />
          <input className="input search-input" placeholder="Search features…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search features" />
        </div>
        <span className="grow" />
        <div className="segmented compact">
          <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => changeView('list')}><List size={14} /> List</button>
          <button type="button" className={view === 'board' ? 'active' : ''} onClick={() => changeView('board')}><Columns3 size={14} /> Board</button>
        </div>
        <button className="btn btn-primary" onClick={onCreate}><Plus size={16} /> New feature</button>
      </div>
      <div className="pipeline" style={{ marginBottom: 10 }}>
        <button className={`pipe ${stage === '' ? 'active' : ''}`} style={{ '--c': project.color }} onClick={() => setStage('')}>
          All <b>{matched.length}</b>
        </button>
        {FEATURE_STAGES.map((s) => {
          const count = matched.filter((f) => f.stage === s.key).length
          return (
            <button key={s.key} className={`pipe ${stage === s.key ? 'active' : ''}`} style={{ '--c': s.color }} onClick={() => setStage(stage === s.key ? '' : s.key)}>
              <i /> {s.label} <b>{count}</b>
            </button>
          )
        })}
      </div>
      <p className="small muted" style={{ marginBottom: 12 }}>
        {term ? `${matched.length} of ${features.length} features match. ` : ''}{released} of {features.length} features released.{project.signoff_gated ? ' Each stage is signed off by the owner or a manager before the next one starts.' : view === 'board' && ' Drag a card to another column to change its stage.'}
      </p>

      {view === 'board' ? (
        <div className="kanban kanban-7">
          {FEATURE_STAGES.filter((s) => !stage || s.key === stage).map((s) => {
            const cards = matched.filter((f) => f.stage === s.key)
            return (
              <div
                key={s.key}
                className={`kcol ${overStage === s.key && dragId != null ? 'over' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOverStage(s.key)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const dragged = features.find((f) => f.id === dragId)
                  if (dragged && dragged.stage !== s.key) setFeatureStage(dragged, s.key)
                  setDragId(null)
                  setOverStage(null)
                }}
              >
                <div className="kcol-header"><i style={{ background: s.color }} />{s.label}<span className="n">{cards.length}</span></div>
                <div className="kcol-body">
                  {cards.map((f) => (
                    <div
                      key={f.id}
                      className={`kcard ${dragId === f.id ? 'dragging' : ''}`}
                      draggable
                      tabIndex={0}
                      role="button"
                      onClick={() => onOpen(f.id)}
                      onKeyDown={(e) => e.key === 'Enter' && onOpen(f.id)}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', String(f.id))
                        setDragId(f.id)
                      }}
                      onDragEnd={() => {
                        setDragId(null)
                        setOverStage(null)
                      }}
                    >
                      <div className="kcard-title">{f.title}</div>
                      {f.issue_count > 0 && <Progress value={f.progress} color={s.color} />}
                      <div className="kcard-meta">
                        <PriorityIcon priority={f.priority} />
                        <span className="due">{f.issue_count ? `${f.done_count}/${f.issue_count}` : 'No issues'}</span>
                        <span className="spacer" />
                        {f.target_date && (
                          <span className={`due ${isOverdue(f.target_date, f.stage === 'released') ? 'overdue' : ''}`}><CalendarDays size={12} /> {formatDate(f.target_date)}</span>
                        )}
                        <Avatar user={f.owner} size={22} title={f.owner ? f.owner.full_name : 'No owner'} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      ) : shown.length === 0 ? (
        <div className="card">
          <Empty icon={term ? Search : Layers} title={term ? `No features match “${query.trim()}”` : 'No features at this stage'}>
            {term && (stage ? 'Try another stage or clear the search.' : 'Try a different word.')}
          </Empty>
        </div>
      ) : (
        <div className="card">
          {shown.map((f) => {
            const meta = byKey(FEATURE_STAGES, f.stage)
            return (
              <div className="feature-block" key={f.id}>
              <div className="feature-row">
                <div style={{ minWidth: 0 }}>
                  <button className="feature-title truncate" onClick={() => onOpen(f.id)}>{f.title}</button>
                  <div className="row row-wrap small muted" style={{ gap: 12, marginTop: 4 }}>
                    <PriorityIcon priority={f.priority} label />
                    {f.owner ? <span className="row" style={{ gap: 6 }}><Avatar user={f.owner} size={18} /> {f.owner.full_name}</span> : <span className="faint">No owner</span>}
                    {f.target_date && (
                      <span className={`due ${isOverdue(f.target_date, f.stage === 'released') ? 'overdue' : ''}`}>
                        <CalendarDays size={12} /> {formatDate(f.target_date)}
                      </span>
                    )}
                    {f.release_version && <span className="tag"><Rocket size={11} /> {f.release_version}</span>}
                    {f.module_name && <span className="tag module-tag" title="Module"><Boxes size={11} /> {f.module_name}</span>}
                    {f.milestone_name && <span className="tag" title="Milestone"><Flag size={11} /> {f.milestone_name}</span>}
                  </div>
                </div>
                <div>
                  <div className="row between small muted" style={{ marginBottom: 5 }}>
                    <span>{f.issue_count ? `${f.done_count}/${f.issue_count} issues` : 'No issues'}</span>
                    {f.issue_count > 0 && <b>{f.progress}%</b>}
                  </div>
                  <Progress value={f.progress} color={meta.color} />
                </div>
                {project.signoff_gated ? (
                  <Badge color={meta.color}>{meta.label}</Badge>
                ) : (
                  <select
                    className="select stage-select"
                    style={{ '--c': meta.color }}
                    value={f.stage}
                    onChange={(e) => setFeatureStage(f, e.target.value)}
                    aria-label={`Stage of ${f.title}`}
                  >
                    {FEATURE_STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                )}
                <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onOpen(f.id)} aria-label={`Edit ${f.title}`}><Pencil size={14} /></button>
              </div>
              {project.signoff_gated && <div className="feature-lifecycle"><StageSignoff project={project} type="feature" item={f} /></div>}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

/* ───────────── Releases tab ───────────── */

function ReleaseModal({ project, release, features, onClose }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const [form, setForm] = useState({
    version: release?.version || '',
    environment: release?.environment || 'production',
    status: release?.status || 'planned',
    planned_date: release?.planned_date || '',
    notes: release?.notes || '',
    feature_ids: release?.features.map((f) => f.id) || [],
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }))
  const toggle = (id) =>
    setForm((f) => ({ ...f, feature_ids: f.feature_ids.includes(id) ? f.feature_ids.filter((x) => x !== id) : [...f.feature_ids, id] }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    const body = { ...form, planned_date: form.planned_date || null }
    try {
      if (release) await api(`/releases/${release.id}`, { method: 'PATCH', body })
      else await api(`/projects/${project.id}/releases`, { method: 'POST', body })
      toast(release ? 'Release saved' : 'Release planned')
      notifyChanged()
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  // A feature can be in one release; offer unassigned ones plus those already here.
  const selectable = features.filter((f) => !f.release_id || f.release_id === release?.id)

  return (
    <Modal title={release ? `Edit release ${release.version}` : 'Plan a release'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}
          <div className="form-grid">
            <Field label="Version">
              <input className="input" value={form.version} onChange={set('version')} maxLength={60} placeholder="v1.0.0" autoFocus required />
            </Field>
            <Field label="Environment">
              <select className="select" value={form.environment} onChange={set('environment')}>
                {ENVIRONMENTS.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select className="select" value={form.status} onChange={set('status')}>
                {RELEASE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="Planned date">
              <input className="input" type="date" value={form.planned_date} onChange={set('planned_date')} />
            </Field>
          </div>
          <Field label="Release notes / deployment checklist">
            <textarea className="textarea" value={form.notes} onChange={set('notes')} placeholder={'- Back up database\n- Run migrations\n- Smoke test checkout'} />
          </Field>
          <Field label="Features in this release" as="div" hint="Deploying to production marks these features as Released.">
            {selectable.length === 0 ? (
              <span className="muted small">No unscheduled features. Add features first, or free one from another release.</span>
            ) : (
              <div className="check-list">
                {selectable.map((f) => (
                  <label className="check-item" key={f.id}>
                    <input type="checkbox" checked={form.feature_ids.includes(f.id)} onChange={() => toggle(f.id)} />
                    <span className="grow truncate">{f.title}</span>
                    <Badge color={byKey(FEATURE_STAGES, f.stage).color}>{byKey(FEATURE_STAGES, f.stage).label}</Badge>
                  </label>
                ))}
              </div>
            )}
          </Field>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !form.version.trim()}>{busy ? <Spinner /> : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

export function Releases({ project, releases, features }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const confirm = useConfirm()
  const [editing, setEditing] = useState(null) // null | 'new' | release
  const [asking, setAsking] = useState(null)
  const [approvals, setApprovals] = useState([])
  useEffect(() => {
    if (!asking) api(`/projects/${project.id}/approvals`).then(setApprovals).catch(() => {})
  }, [project.id, asking])

  const deploy = async (r) => {
    const notReady = r.features.filter((f) => !['deployment', 'released'].includes(f.stage)).length
    const ok = await confirm({
      title: `Mark ${r.version} as deployed to ${r.environment}?`,
      message:
        (r.environment === 'production' && r.features.length
          ? `Its ${r.features.length} feature(s) will be marked as Released. `
          : '') + (notReady ? `${notReady} of them have not reached the Deployment stage yet.` : ''),
      confirmLabel: 'Mark deployed',
    })
    if (!ok) return
    try {
      await api(`/releases/${r.id}`, { method: 'PATCH', body: { status: 'deployed' } })
      toast(`${r.version} deployed`)
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const remove = async (r) => {
    const ok = await confirm({ title: `Delete release ${r.version}?`, message: 'It moves to the recycle bin for 30 days.', confirmLabel: 'Delete', danger: true })
    if (!ok) return
    try {
      await api(`/releases/${r.id}`, { method: 'DELETE' })
      undo('release', r.id, `Release ${r.version}`)
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <>
      <div className="toolbar">
        <span className="muted grow">Plan deployments, record what shipped where, and keep a release history.</span>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> Plan release</button>
      </div>
      {releases.length === 0 ? (
        <div className="card"><Empty icon={Rocket} title="No releases yet">Plan a release, add the features it will ship, and mark it deployed when it goes out.</Empty></div>
      ) : (
        <div className="grid grid-cards">
          {releases.map((r) => {
            const status = byKey(RELEASE_STATUSES, r.status)
            const pending = ['planned', 'in_progress'].includes(r.status)
            return (
              <div className="card release-card" key={r.id}>
                <div className="row between">
                  <span className="release-version truncate">{r.version}</span>
                  <Badge color={status.color}>{status.label}</Badge>
                </div>
                <div className="row row-wrap small muted" style={{ gap: 12 }}>
                  <span className="tag">{byKey(ENVIRONMENTS, r.environment).label}</span>
                  {r.deployed_at ? (
                    <span>Deployed {formatDate(r.deployed_at, true)}</span>
                  ) : r.planned_date ? (
                    <span className={`due ${isOverdue(r.planned_date, !pending) ? 'overdue' : ''}`}><CalendarDays size={12} /> Planned {formatDate(r.planned_date, true)}</span>
                  ) : (
                    <span>No date</span>
                  )}
                </div>
                {r.notes && <p className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 96, overflow: 'auto' }}>{r.notes}</p>}
                <div>
                  <div className="section-title" style={{ marginBottom: 6 }}>Features · {r.features.length}</div>
                  {r.features.length === 0 ? (
                    <span className="small faint">None added yet</span>
                  ) : (
                    <div className="row row-wrap" style={{ gap: 6 }}>
                      {r.features.map((f) => (
                        <span className="tag" key={f.id} title={byKey(FEATURE_STAGES, f.stage).label}>
                          <i style={{ width: 6, height: 6, borderRadius: '50%', background: byKey(FEATURE_STAGES, f.stage).color }} /> {f.title}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="row between" style={{ marginTop: 'auto' }}>
                  {pending ? (
                    <button className="btn btn-sm btn-primary" onClick={() => deploy(r)}><Rocket size={14} /> Mark deployed</button>
                  ) : <span />}
                  <span className="row" style={{ gap: 2 }}>
                    {(() => {
                      const latest = approvals.find((a) => a.kind === 'release' && a.target_id === r.id && ['pending', 'approved'].includes(a.status))
                      return latest ? <ApprovalBadge approval={latest} /> : <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setAsking(r)} aria-label="Request approval" title="Request approval"><Stamp size={14} /></button>
                    })()}
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setEditing(r)} aria-label="Edit release"><Pencil size={14} /></button>
                    {project.can_manage && (
                      <button className="btn btn-ghost btn-sm btn-icon danger-text" onClick={() => remove(r)} aria-label="Delete release"><Trash2 size={14} /></button>
                    )}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {asking && <RequestApprovalModal project={project} kind="release" targetId={asking.id} defaultTitle={`Approve release ${asking.version} to ${asking.environment}`} onClose={() => setAsking(null)} />}
      {editing && (
        <ReleaseModal project={project} release={editing === 'new' ? null : editing} features={features} onClose={() => setEditing(null)} />
      )}
    </>
  )
}
