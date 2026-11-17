import { useEffect, useState } from 'react'
import { Check, Eye, EyeOff, FileText, Hourglass, Pencil, Plus, Send, Trash2, Zap } from 'lucide-react'
import { api, notifyChanged } from '../api'
import { useAuth, useConfirm, useToast } from '../context'
import { Avatar, Field, FEATURE_STAGES, MILESTONE_STAGES, byKey, Modal, PRIORITIES, Spinner, TYPES, statusesOf, timeAgo } from '../ui'
import { RichEditor } from './RichText'

/* ═════════════ Watch button ═════════════ */

export function WatchButton({ kind, id }) {
  const toast = useToast()
  const [state, setState] = useState(null)

  useEffect(() => {
    api(`/${kind}s/${id}/watchers`).then(setState).catch(() => {})
  }, [kind, id])

  const toggle = async () => {
    try {
      setState(await api(`/${kind}s/${id}/watch`, { method: state.watching ? 'DELETE' : 'POST' }))
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  if (!state) return null
  const others = state.watchers.length
  return (
    <button
      type="button"
      className={`btn btn-sm ${state.watching ? '' : 'btn-ghost'}`}
      onClick={toggle}
      title={others ? `Watching: ${state.watchers.map((w) => w.full_name).join(', ')}` : 'Nobody is watching yet'}
      aria-pressed={state.watching}
    >
      {state.watching ? <Eye size={14} /> : <EyeOff size={14} />} {state.watching ? 'Watching' : 'Watch'}
      {others > 0 && <span className="faint">{others}</span>}
    </button>
  )
}

/* ═════════════ Issue templates ═════════════ */

function TemplateModal({ project, template, onClose, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState({
    name: template?.name || '',
    title: template?.title || '',
    description: template?.description || '',
    type: template?.type || 'task',
    priority: template?.priority || 'medium',
    labels: (template?.labels || []).join(', '),
    checklist: (template?.checklist || []).join('\n'),
  })
  const [busy, setBusy] = useState(false)
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    const body = {
      ...form,
      labels: form.labels.split(',').map((l) => l.trim()).filter(Boolean),
      checklist: form.checklist.split('\n').map((l) => l.trim()).filter(Boolean),
    }
    try {
      if (template) await api(`/issue-templates/${template.id}`, { method: 'PUT', body })
      else await api(`/projects/${project.id}/issue-templates`, { method: 'POST', body })
      onSaved()
      onClose()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }

  return (
    <Modal title={template ? `Edit “${template.name}”` : 'New issue template'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="form-grid">
            <Field label="Template name"><input className="input" value={form.name} maxLength={80} onChange={set('name')} placeholder="e.g. Bug report" autoFocus required /></Field>
            <Field label="Title starts with"><input className="input" value={form.title} maxLength={200} onChange={set('title')} placeholder="e.g. Bug: " /></Field>
            <Field label="Type">
              <select className="select" value={form.type} onChange={set('type')}>{TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
            </Field>
            <Field label="Priority">
              <select className="select" value={form.priority} onChange={set('priority')}>{PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
            </Field>
          </div>
          <Field label="Description" as="div">
            <RichEditor value={form.description} onChange={(description) => setForm((f) => ({ ...f, description }))} minHeight={140} placeholder="The sections people should fill in" />
          </Field>
          <div className="form-grid">
            <Field label="Labels" hint="Comma separated"><input className="input" value={form.labels} onChange={set('labels')} placeholder="bug, customer" /></Field>
            <Field label="Checklist" hint="One sub-task per line">
              <textarea className="textarea" style={{ minHeight: 80 }} value={form.checklist} onChange={set('checklist')} placeholder={'Reproduced\nFixed\nVerified'} />
            </Field>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? <Spinner /> : 'Save template'}</button>
        </div>
      </form>
    </Modal>
  )
}

export function IssueTemplatesCard({ project }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [templates, setTemplates] = useState([])
  const [editing, setEditing] = useState(null)

  const load = () => api(`/projects/${project.id}/issue-templates`).then(setTemplates).catch(() => {})
  useEffect(() => {
    load()
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const addDefaults = async () => {
    try {
      setTemplates(await api(`/projects/${project.id}/issue-templates/defaults`, { method: 'POST' }))
      toast('Bug report and Feature request templates added')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const remove = async (t) => {
    if (!(await confirm({ title: `Delete the “${t.name}” template?`, confirmLabel: 'Delete', danger: true }))) return
    try {
      await api(`/issue-templates/${t.id}`, { method: 'DELETE' })
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div className="card card-pad stack">
      <div>
        <h2>Issue templates</h2>
        <p className="muted small">Pre-filled forms people can pick when creating an issue: title, description, type, priority, labels and a checklist.</p>
      </div>
      {templates.map((t) => (
        <div className="wf-row" key={t.id} style={{ borderTop: '1px solid var(--border)' }}>
          <FileText size={15} />
          <b className="grow truncate">{t.name}</b>
          <span className="faint small hide-mobile">{t.type} · {t.priority}{t.checklist.length ? ` · ${t.checklist.length} sub-tasks` : ''}</span>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}><Pencil size={14} /></button>
          <button className="btn btn-ghost btn-icon btn-sm danger-text" onClick={() => remove(t)} aria-label={`Delete ${t.name}`}><Trash2 size={14} /></button>
        </div>
      ))}
      <div className="row row-wrap">
        <button className="btn btn-sm" onClick={() => setEditing('new')}><Plus size={14} /> New template</button>
        {!templates.some((t) => t.name === 'Bug report') && <button className="btn btn-ghost btn-sm" onClick={addDefaults}>Add bug report and feature request</button>}
      </div>
      {editing && <TemplateModal project={project} template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  )
}

/* ═════════════ Automation rules ═════════════ */

const TRIGGERS = [
  { key: 'issue_created', label: 'An issue is created' },
  { key: 'status_changed', label: 'An issue moves to a status' },
  { key: 'due_soon', label: 'An issue is due soon' },
  { key: 'feature_done', label: 'Every issue of a feature is done' },
]

const ACTIONS = [
  { key: 'assign', label: 'Assign it to' },
  { key: 'set_priority', label: 'Set priority to' },
  { key: 'set_status', label: 'Move it to status' },
  { key: 'add_label', label: 'Add the label' },
  { key: 'notify', label: 'Notify' },
  { key: 'comment', label: 'Post a comment' },
  { key: 'feature_stage', label: 'Move the feature to stage' },
]

function describe(rule, project) {
  const c = rule.config || {}
  const a = c.action || {}
  const statusLabel = (key) => statusesOf(project).find((s) => s.key === key)?.label || key
  const member = (id) => project.members.find((m) => m.id === id)?.full_name || 'someone'
  const when = {
    issue_created: 'When an issue is created',
    status_changed: c.status ? `When an issue moves to ${statusLabel(c.status)}` : 'When an issue changes status',
    due_soon: `When an issue is due ${c.days === 0 ? 'today' : `within ${c.days} day${c.days === 1 ? '' : 's'}`}`,
    feature_done: 'When every issue of a feature is done',
  }[rule.trigger]
  const filters = [c.conditions?.type, c.conditions?.priority && `${c.conditions.priority} priority`].filter(Boolean)
  const then = {
    assign: a.user_id ? `assign it to ${member(a.user_id)}` : 'clear the assignee',
    set_priority: `set priority to ${a.value}`,
    set_status: `move it to ${statusLabel(a.value)}`,
    add_label: `add the label “${a.value}”`,
    notify: `notify ${typeof a.target === 'number' ? member(a.target) : `the ${a.target}`}`,
    comment: 'post a comment',
    feature_stage: `move the feature to ${a.value}`,
  }[a.type]
  return `${when}${filters.length ? ` (${filters.join(', ')} only)` : ''}, ${then}.`
}

function RuleModal({ project, rule, onClose, onSaved }) {
  const toast = useToast()
  const c = rule?.config || {}
  const [form, setForm] = useState({
    name: rule?.name || '',
    trigger: rule?.trigger || 'status_changed',
    status: c.status || '',
    days: c.days ?? 2,
    type: c.conditions?.type || '',
    priority: c.conditions?.priority || '',
    action: c.action?.type || 'assign',
    user_id: c.action?.user_id ?? '',
    value: c.action?.value || '',
    target: c.action?.target ?? 'assignee',
    enabled: rule ? rule.enabled : true,
  })
  const [busy, setBusy] = useState(false)
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }))
  const featureRule = form.trigger === 'feature_done'
  const allowed = ACTIONS.filter((a) => (featureRule ? ['feature_stage', 'notify'].includes(a.key) : a.key !== 'feature_stage'))

  useEffect(() => {
    if (!allowed.some((a) => a.key === form.action)) setForm((f) => ({ ...f, action: allowed[0].key, value: '' }))
  }, [form.trigger]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    const action = { type: form.action }
    if (form.action === 'assign') action.user_id = form.user_id === '' ? null : Number(form.user_id)
    else if (form.action === 'notify') {
      action.target = /^\d+$/.test(String(form.target)) ? Number(form.target) : form.target
      action.value = form.value
    } else action.value = form.value
    const config = { conditions: { type: form.type || null, priority: form.priority || null }, action }
    if (form.trigger === 'status_changed') config.status = form.status
    if (form.trigger === 'due_soon') config.days = Number(form.days)
    const body = { name: form.name, trigger: form.trigger, config, enabled: form.enabled }
    try {
      if (rule) await api(`/automations/${rule.id}`, { method: 'PUT', body })
      else await api(`/projects/${project.id}/automations`, { method: 'POST', body })
      toast(rule ? 'Rule saved' : 'Rule added')
      onSaved()
      onClose()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }

  return (
    <Modal title={rule ? 'Edit rule' : 'New automation rule'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <Field label="Rule name"><input className="input" value={form.name} maxLength={120} onChange={set('name')} placeholder="e.g. Send QA work to Mira" autoFocus required /></Field>
          <div className="rule-block">
            <span className="rule-word">When</span>
            <select className="select" value={form.trigger} onChange={set('trigger')}>{TRIGGERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
            {form.trigger === 'status_changed' && (
              <select className="select" value={form.status} onChange={set('status')} aria-label="Status">
                <option value="">Any status</option>
                {statusesOf(project).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            )}
            {form.trigger === 'due_soon' && (
              <span className="row" style={{ gap: 6 }}>
                <span className="muted small">within</span>
                <input className="input" type="number" min="0" max="30" value={form.days} onChange={set('days')} style={{ width: 80 }} aria-label="Days" />
                <span className="muted small">days (checked every 15 minutes, once per issue)</span>
              </span>
            )}
          </div>
          {!featureRule && (
            <div className="rule-block">
              <span className="rule-word">Only if</span>
              <select className="select" value={form.type} onChange={set('type')} aria-label="Issue type">
                <option value="">Any type</option>{TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              <select className="select" value={form.priority} onChange={set('priority')} aria-label="Priority">
                <option value="">Any priority</option>{PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
          )}
          <div className="rule-block">
            <span className="rule-word">Then</span>
            <select className="select" value={form.action} onChange={(e) => setForm((f) => ({ ...f, action: e.target.value, value: '' }))}>
              {allowed.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            </select>
            {form.action === 'assign' && (
              <select className="select" value={form.user_id} onChange={set('user_id')} aria-label="Assignee">
                <option value="">Nobody (unassign)</option>
                {project.members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select>
            )}
            {form.action === 'set_priority' && (
              <select className="select" value={form.value} onChange={set('value')} required aria-label="Priority"><option value="">Choose…</option>{PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
            )}
            {form.action === 'set_status' && (
              <select className="select" value={form.value} onChange={set('value')} required aria-label="Status"><option value="">Choose…</option>{statusesOf(project).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
            )}
            {form.action === 'feature_stage' && (
              <select className="select" value={form.value} onChange={set('value')} required aria-label="Stage"><option value="">Choose…</option>{FEATURE_STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
            )}
            {form.action === 'add_label' && <input className="input" value={form.value} maxLength={30} onChange={set('value')} placeholder="label" required aria-label="Label" />}
            {form.action === 'notify' && (
              <select className="select" value={form.target} onChange={set('target')} aria-label="Who to notify">
                <option value="assignee">{featureRule ? 'The feature owner' : 'The assignee'}</option>
                {!featureRule && <option value="reporter">The reporter</option>}
                <option value="watchers">The watchers</option>
                <option value="owner">The project owner</option>
                {project.members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select>
            )}
          </div>
          {(form.action === 'comment' || form.action === 'notify') && (
            <Field label={form.action === 'comment' ? 'Comment' : 'Message (optional)'}>
              <textarea className="textarea" style={{ minHeight: 70 }} value={form.value} onChange={set('value')} maxLength={form.action === 'comment' ? 2000 : 300} required={form.action === 'comment'} placeholder={form.action === 'comment' ? 'e.g. Please attach screenshots before review.' : 'e.g. This needs a code review'} />
            </Field>
          )}
          <label className="check-item"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} /> Rule is on</label>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? <Spinner /> : 'Save rule'}</button>
        </div>
      </form>
    </Modal>
  )
}

export function AutomationsCard({ project }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [rules, setRules] = useState(null)
  const [editing, setEditing] = useState(null)

  const load = () => api(`/projects/${project.id}/automations`).then(setRules).catch(() => setRules([]))
  useEffect(() => {
    load()
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (rule) => {
    try {
      await api(`/automations/${rule.id}`, { method: 'PUT', body: { name: rule.name, trigger: rule.trigger, config: rule.config, enabled: !rule.enabled } })
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const remove = async (rule) => {
    if (!(await confirm({ title: `Delete the rule “${rule.name}”?`, confirmLabel: 'Delete', danger: true }))) return
    try {
      await api(`/automations/${rule.id}`, { method: 'DELETE' })
      load()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div className="card card-pad stack">
      <div>
        <h2>Automation rules</h2>
        <p className="muted small">Let Trackly do routine updates: assign work, set fields, send reminders and move features along. Changes made by rules show in the activity log with ⚡.</p>
      </div>
      {rules === null ? <Spinner /> : rules.length === 0 ? (
        <p className="muted small">No rules yet.</p>
      ) : (
        rules.map((rule) => (
          <div className="rule-row" key={rule.id} style={rule.enabled ? undefined : { opacity: 0.55 }}>
            <Zap size={16} color={rule.enabled ? 'var(--accent)' : 'var(--text-3)'} />
            <span className="grow" style={{ minWidth: 0 }}>
              <b>{rule.name}</b>
              <div className="small muted">{describe(rule, project)}</div>
              <div className="faint small">{rule.runs ? `Ran ${rule.runs} time${rule.runs === 1 ? '' : 's'}, last ${timeAgo(rule.last_run_at)}` : 'Has not run yet'}</div>
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => toggle(rule)}>{rule.enabled ? 'Turn off' : 'Turn on'}</button>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setEditing(rule)} aria-label={`Edit ${rule.name}`}><Pencil size={14} /></button>
            <button className="btn btn-ghost btn-icon btn-sm danger-text" onClick={() => remove(rule)} aria-label={`Delete ${rule.name}`}><Trash2 size={14} /></button>
          </div>
        ))
      )}
      <div><button className="btn btn-sm" onClick={() => setEditing('new')}><Plus size={14} /> New rule</button></div>
      {editing && <RuleModal project={project} rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  )
}

/* ═════════════ Approvals ═════════════ */

const APPROVAL_STATUS = {
  pending: { label: 'Waiting', color: '#f59e0b' },
  approved: { label: 'Approved', color: '#22c55e' },
  rejected: { label: 'Rejected', color: '#ef4444' },
  cancelled: { label: 'Cancelled', color: '#94a3b8' },
}

export function ApprovalBadge({ approval }) {
  const meta = APPROVAL_STATUS[approval.status]
  return <span className="badge" style={{ '--badge': meta.color }}><i />{meta.label}</span>
}

/** Ask someone to approve. kind: feature | release | phase | general */
export function RequestApprovalModal({ project, kind, targetId, phase, defaultTitle = '', onClose, onDone }) {
  const { user } = useAuth()
  const toast = useToast()
  // Approval requests go to the project owner and its managers only.
  const people = project.members.filter((m) => m.id !== user.id && (m.role === 'owner' || m.role === 'manager'))
  const [form, setForm] = useState({ approver_id: '', title: defaultTitle, note: '' })
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/projects/${project.id}/approvals`, {
        method: 'POST',
        body: { kind, target_id: targetId ?? null, phase: phase ?? null, title: form.title, note: form.note, approver_id: form.approver_id ? Number(form.approver_id) : null },
      })
      toast('Approval requested')
      notifyChanged()
      onDone?.()
      onClose()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }

  return (
    <Modal title="Request approval" onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <div className="modal-body">
          {people.length === 0 ? <p className="muted">Only the project owner and managers can approve, and nobody else has that role yet. Give a member the Manager role first.</p> : (
            <>
              <Field label="Ask">
                <select className="select" value={form.approver_id} onChange={(e) => setForm({ ...form, approver_id: e.target.value })}>
                  <option value="">The owner or any manager (first to answer)</option>
                  {people.map((m) => <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>)}
                </select>
              </Field>
              <Field label="What needs approval" hint={kind === 'general' ? undefined : 'Leave empty for a standard title'}>
                <input className="input" value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={defaultTitle || 'e.g. Sign off the launch budget'} required={kind === 'general'} />
              </Field>
              <Field label="Note"><textarea className="textarea" style={{ minHeight: 80 }} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Context, links, what you need from them" /></Field>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !people.length}>{busy ? <Spinner /> : 'Send request'}</button>
        </div>
      </form>
    </Modal>
  )
}

/** The lifecycle of one feature or milestone: where it is, and the sign-off that moves it on. */
export function StageSignoff({ project, type, item, onChanged, compact = false, dense = false }) {
  const { user } = useAuth()
  const toast = useToast()
  const [deciding, setDeciding] = useState(null) // 'approved' | 'rejected' | 'request'
  const [note, setNote] = useState('')
  const [askWho, setAskWho] = useState('')
  const [busy, setBusy] = useState(false)
  const stages = type === 'feature' ? FEATURE_STAGES : MILESTONE_STAGES
  if (!project.signoff_gated) return null
  const pending = item.signoff
  const current = byKey(stages, item.stage)
  const next = item.next_stage ? byKey(stages, item.next_stage) : null
  const name = type === 'feature' ? item.title : item.name
  const canEdit = project.can_edit && project.sections.includes(type === 'feature' ? 'features' : 'milestones')
  const checks = item.checklist || []
  const missing = checks.filter((c) => !c.done).length
  const gate = type === 'milestone' ? item.feature_gate : null
  const behind = gate?.behind?.length || 0
  const blockedTitle = missing
    ? `Finish the ${current.label} checklist first (${missing} left)`
    : behind ? `${behind} of its features ${behind === 1 ? 'is' : 'are'} not at ${current.label} yet` : undefined
  const blocked = missing > 0 || behind > 0
  // Requests are decided by the owner or a manager: the one named in it, or any of them.
  // Your own request needs someone else, unless you are the only one who can approve.
  const strictMode = project.signoff_mode === 'strict'
  const others = (project.approver_ids || []).filter((id) => id !== user.id)
  const mayDecide = Boolean(pending) && (
    pending.approver ? pending.approver.id === user.id
      : project.can_approve && (!strictMode || pending.requester?.id !== user.id || others.length === 0)
  )
  const oneClick = !strictMode && project.can_approve
  const askable = project.members.filter((m) => (project.approver_ids || []).includes(m.id) && m.id !== user.id)
  const tick = async (c) => {
    try {
      await api('/signoff-checks', { method: 'POST', body: { criterion_id: c.id, target_id: item.id, done: !c.done } })
      notifyChanged()
      onChanged?.()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const run = async () => {
    setBusy(true)
    try {
      if (deciding === 'now') {
        await api(`/projects/${project.id}/signoffs`, { method: 'POST', body: { target_type: type, target_id: item.id, note, approve: true } })
        toast(`${current.label} signed off. Now in ${next.label}.`)
      } else if (deciding === 'request') {
        await api(`/projects/${project.id}/signoffs`, { method: 'POST', body: { target_type: type, target_id: item.id, note, approver_id: askWho ? Number(askWho) : null } })
        toast(askWho ? 'Sign-off requested' : 'Sign-off requested from the owner and managers')
      } else {
        await api(`/approvals/${pending.id}/decide`, { method: 'POST', body: { decision: deciding, note } })
        toast(deciding === 'approved' ? `${current.label} signed off. Now in ${next.label}.` : 'Sign-off declined')
      }
      setDeciding(null)
      setNote('')
      notifyChanged()
      onChanged?.()
    } catch (err) {
      toast(err.message, 'error')
    }
    setBusy(false)
  }
  const cancel = async () => {
    try {
      await api(`/approvals/${pending.id}/cancel`, { method: 'POST' })
      notifyChanged()
      onChanged?.()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const titles = {
    request: `Request sign-off: ${current.label}`,
    now: `Sign off ${current.label}?`,
    approved: `Sign off ${current.label}?`, rejected: `Decline the ${current.label} sign-off?`,
  }
  return (
    <div className={`signoff ${compact ? 'compact' : ''}`} onClick={(e) => e.stopPropagation()}>
      {!compact && (
        <ol className={`lifecycle ${dense ? 'dense' : ''}`} aria-label={`Lifecycle. Current stage: ${current.label}`}>
          {stages.map((s, n) => {
            const index = stages.findIndex((x) => x.key === item.stage)
            const state = n < index ? 'done' : n === index ? 'now' : ''
            return (
              <li key={s.key} className={state} style={{ '--c': s.color }} title={`${s.label}${state === 'done' ? ': signed off' : state === 'now' ? ': current stage' : ''}`}>
                <span className="lifecycle-dot">{state === 'done' ? <Check size={11} strokeWidth={3} /> : n + 1}</span>
                <span className="lifecycle-label">{s.label}</span>
              </li>
            )
          })}
        </ol>
      )}
      {checks.length > 0 && (compact ? (
        <span className={`small ${missing ? 'muted' : ''}`} style={missing ? undefined : { color: '#16a34a' }}>{checks.length - missing}/{checks.length} checks</span>
      ) : (
        <div className="stage-checks">
          <div className="section-title" style={{ marginBottom: 2 }}>Before {current.label} is signed off</div>
          {checks.map((c) => (
            <label key={c.id} className={`opt-row ${c.done ? 'done' : ''}`} title={c.kind === 'manual' ? undefined : 'Checked automatically'}>
              <input type="checkbox" checked={c.done} disabled={c.kind !== 'manual' || !canEdit} onChange={() => tick(c)} />
              <span>{c.text}{c.kind !== 'manual' ? <span className="faint"> · {c.detail}</span> : c.by ? <span className="faint"> · {c.by}</span> : null}</span>
            </label>
          ))}
        </div>
      ))}
      {gate && !compact && (
        <div className="small muted">
          {gate.signed_off} of {gate.total} {gate.total === 1 ? 'feature' : 'features'} signed off for {current.label}.{' '}
          {behind > 0
            ? <span className="danger-text">{gate.behind.map((f) => f.title).join(', ')} {behind === 1 ? 'is' : 'are'} still behind, so this milestone waits.</span>
            : next ? 'It moves on by itself when all are, or sign it off here to sign off the remaining features with it.' : ''}
        </div>
      )}
      {pending ? (
        <div className="row row-wrap" style={{ gap: 6 }}>
          <span className={`signoff-wait ${pending.overdue ? 'late' : ''}`}><Hourglass size={12} /> {current.label} sign-off requested{pending.requester ? ` by ${pending.requester.id === user.id ? 'you' : pending.requester.full_name}` : ''}{pending.overdue ? ` · waiting ${pending.waiting_days} days` : ''}</span>
          {mayDecide ? (
            <>
              <button className="btn btn-sm" onClick={() => setDeciding('rejected')}>Decline</button>
              <button className="btn btn-primary btn-sm" disabled={blocked} title={blockedTitle} onClick={() => setDeciding('approved')}><Check size={13} /> Sign off</button>
            </>
          ) : (
            <>
              <span className="small muted">waiting for {pending.approver ? pending.approver.full_name : 'the owner or a manager'}</span>
              {pending.requester?.id === user.id && <button className="btn btn-ghost btn-sm" onClick={cancel}>Cancel request</button>}
            </>
          )}
        </div>
      ) : next ? (
        oneClick ? (
          <button className="btn btn-sm" disabled={blocked} onClick={() => setDeciding('now')} title={blockedTitle || `Finish ${current.label} and move to ${next.label}`}><Check size={13} /> Sign off {current.label}</button>
        ) : canEdit ? (
          <button className="btn btn-sm" disabled={blocked} onClick={() => { setAskWho(''); setDeciding('request') }} title={blockedTitle || 'Ask the owner or a manager to approve this stage'}><Send size={13} /> Request sign-off for {current.label}</button>
        ) : null
      ) : <span className="small" style={{ color: '#16a34a' }}><Check size={13} style={{ verticalAlign: -2 }} /> Every stage is signed off</span>}
      {!pending && item.last_signoff?.status === 'rejected' && item.last_signoff.stage === item.stage && (
        <div className="small danger-text">Not signed off{item.last_signoff.by ? ` by ${item.last_signoff.by.full_name}` : ''}{item.last_signoff.note ? `: ${item.last_signoff.note}` : ''}</div>
      )}
      {deciding && (
        <Modal title={titles[deciding]} onClose={() => setDeciding(null)} size="sm">
          <div className="modal-body stack">
            <p className="muted">
              <b>{name}</b>{' '}
              {deciding === 'request'
                ? `finished ${current.label}? It moves to ${next.label} only after the project owner or a manager approves this request.`
                : deciding === 'now'
                ? `moves from ${current.label} to ${next.label}. Stages cannot be skipped.`
                : deciding === 'rejected'
                  ? `stays in ${current.label}. Tell the team what is missing.`
                  : `moves from ${current.label} to ${next.label}. Stages cannot be skipped.`}
              {gate?.at_stage > 0 && deciding !== 'rejected' && ` Its ${gate.at_stage} ${gate.at_stage === 1 ? 'feature' : 'features'} still in ${current.label} ${gate.at_stage === 1 ? 'is' : 'are'} signed off with it.`}
            </p>
            {deciding === 'request' && (
              <Field label="Ask" hint={askable.length === 0 ? 'Nobody else has the owner or manager role in this project, so the request goes to the owner.' : undefined}>
                <select className="select" value={askWho} onChange={(e) => setAskWho(e.target.value)}>
                  <option value="">The owner and all managers (first to answer decides)</option>
                  {askable.map((m) => <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>)}
                </select>
              </Field>
            )}
            <Field label={deciding === 'rejected' ? 'What needs to change' : 'Note (optional)'}>
              <textarea className="textarea" style={{ minHeight: 70 }} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
            </Field>
          </div>
          <div className="modal-footer">
            <button className="btn" onClick={() => setDeciding(null)}>Cancel</button>
            <button className={`btn ${deciding === 'rejected' ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={run}>
              {busy ? <Spinner /> : deciding === 'request' ? 'Send request' : deciding === 'rejected' ? 'Decline' : 'Sign off'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

export function Approvals({ project }) {
  const { user } = useAuth()
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [asking, setAsking] = useState(false)
  const [deciding, setDeciding] = useState(null) // { approval, decision }
  const [note, setNote] = useState('')

  const load = () => api(`/projects/${project.id}/approvals`).then(setRows).catch(() => setRows([]))
  useEffect(() => {
    load()
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async () => {
    try {
      await api(`/approvals/${deciding.approval.id}/decide`, { method: 'POST', body: { decision: deciding.decision, note } })
      toast(deciding.decision === 'approved' ? 'Approved' : 'Rejected')
      setDeciding(null)
      setNote('')
      load()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const cancel = async (a) => {
    try {
      await api(`/approvals/${a.id}/cancel`, { method: 'POST' })
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  if (!rows) return <Spinner />
  const pending = rows.filter((a) => a.status === 'pending')
  const forMe = pending.filter((a) => a.can_decide)
  const forOthers = pending.filter((a) => !a.can_decide)
  const decided = rows.filter((a) => a.status !== 'pending')

  const row = (a) => (
    <div className="list-row" key={a.id} style={{ cursor: 'default', alignItems: 'flex-start' }}>
      <Avatar user={a.requester} size={30} />
      <span className="grow" style={{ minWidth: 0 }}>
        <div className="row row-wrap" style={{ gap: 8 }}>
          <span className="tag">{a.kind_label}</span>
          <b>{a.title}</b>
          <ApprovalBadge approval={a} />
        </div>
        <div className="small muted">
          {a.requester?.id === user.id ? 'You' : a.requester?.full_name || 'Automation'} asked{' '}
          {a.approver && a.status === 'pending' ? (a.approver.id === user.id ? 'you' : a.approver.full_name) : 'the owner and managers'} · {timeAgo(a.created_at)}
          {a.decided_at && a.status !== 'cancelled' && ` · ${a.status} by ${a.approver?.full_name || 'the system'} ${timeAgo(a.decided_at)}`}
        </div>
        {a.note && <div className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{a.note}</div>}
        {a.decision_note && <div className="small" style={{ marginTop: 4 }}><b>{a.approver?.full_name || 'Note'}:</b> {a.decision_note}</div>}
      </span>
      {a.status === 'pending' && a.can_decide && (
        <span className="row" style={{ gap: 6 }}>
          <button className="btn btn-sm" onClick={() => setDeciding({ approval: a, decision: 'rejected' })}>Decline</button>
          <button className="btn btn-primary btn-sm" onClick={() => setDeciding({ approval: a, decision: 'approved' })}>{a.kind === 'stage' ? 'Sign off' : 'Approve'}</button>
        </span>
      )}
      {a.status === 'pending' && !a.can_decide && (a.requester?.id === user.id || project.can_manage) && (
        <button className="btn btn-ghost btn-sm" onClick={() => cancel(a)}>Cancel</button>
      )}
    </div>
  )
  const section = (title, list, empty) => (
    <div className="card">
      <div className="card-header"><h2>{title}</h2><span className="muted small">{list.length}</span></div>
      {list.length === 0 ? <div className="card-pad muted small">{empty}</div> : list.map(row)}
    </div>
  )

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <span className="muted grow">
          Every approval in this project, stage sign-offs or otherwise, is decided by the project owner or a manager
          {project.signoff_mode === 'strict' ? ', never by the person who asked.' : '.'}
        </span>
        <button className="btn btn-primary" onClick={() => setAsking(true)}><Plus size={16} /> Request approval</button>
      </div>
      {section('Waiting for you', forMe, 'Nothing needs your decision.')}
      {section('Waiting for others', forOthers, 'No other requests are open.')}
      {decided.length > 0 && section('Decided', decided.slice(0, 50), '')}
      {asking && <RequestApprovalModal project={project} kind="general" onClose={() => setAsking(false)} onDone={load} />}
      {deciding && (
        <Modal title={`${deciding.decision === 'approved' ? 'Approve' : 'Reject'}: ${deciding.approval.title}`} onClose={() => setDeciding(null)} size="sm">
          <div className="modal-body">
            <Field label="Comment (optional)"><textarea className="textarea" style={{ minHeight: 80 }} value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder={deciding.decision === 'approved' ? 'Looks good.' : 'What needs to change?'} /></Field>
          </div>
          <div className="modal-footer">
            <button className="btn" onClick={() => setDeciding(null)}>Cancel</button>
            <button className={`btn ${deciding.decision === 'approved' ? 'btn-primary' : 'btn-danger'}`} onClick={decide}>{deciding.decision === 'approved' ? 'Approve' : 'Reject'}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
