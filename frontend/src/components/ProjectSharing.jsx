import { useEffect, useState } from 'react'
import { Check, Copy, Eye, Link2, MessageSquare, Plus, ShieldCheck, ThumbsUp, Trash2, X } from 'lucide-react'
import { api, notifyChanged } from '../api'
import { useConfirm, useToast } from '../context'
import { Badge, FEATURE_STAGES, Field, MILESTONE_STAGES, Modal, Spinner, formatDate, timeAgo } from '../ui'
import { PlanGate, useFeature } from './License'
import SignoffModePicker from './SignoffModePicker'

/* Project settings: the sign-off rule, and read-only links for clients. */

export function SignoffCard({ project, reload }) {
  const toast = useToast()
  const hasApprovals = useFeature('approvals')
  const advanced = useFeature('approvals_advanced')
  const [busy, setBusy] = useState(false)
  const managers = project.members.filter((m) => m.role === 'manager')
  const owner = project.members.find((m) => m.role === 'owner')

  const setMode = async (signoff_mode) => {
    if (signoff_mode === project.signoff_mode) return
    setBusy(true)
    try {
      await api(`/projects/${project.id}`, { method: 'PATCH', body: { signoff_mode } })
      toast(signoff_mode === 'off' ? 'Stages can now be changed freely' : `Stage sign-off is now ${signoff_mode}`)
      notifyChanged()
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
    setBusy(false)
  }

  return (
    <div className="card card-pad stack">
      <div className="row between row-wrap">
        <h2 className="icon-label"><ShieldCheck size={17} /> <span>Stage sign-off</span></h2>
      </div>
      <SignoffModePicker value={project.signoff_mode} onChange={setMode} disabled={busy || !project.can_manage} strictLocked={!advanced} />
      {project.signoff_mode !== 'off' && (
        <p className="muted small">
          Features and milestones move one stage at a time and nobody skips a stage. Only the owner or a manager can move
          something back. All approvals in this project, stage sign-offs or otherwise, follow the same rule.
        </p>
      )}
      <div className="small">
        <b>Who can sign off:</b> {owner ? owner.full_name : 'the owner'} (owner)
        {managers.length ? `, ${managers.map((m) => m.full_name).join(', ')} (manager)` : '. Give a member the Manager role on the Team tab to add more.'}
      </div>
      {!hasApprovals && project.signoff_mode !== 'off' && (
        <div className="small danger-text">Your plan does not include approvals, so this rule is not enforced right now.</div>
      )}
      {project.signoff_mode !== 'off' && (
        <PlanGate feature="approvals_advanced" compact>
          {project.can_manage && <Reminders project={project} reload={reload} />}
          <Criteria project={project} />
        </PlanGate>
      )}
    </div>
  )
}

function Reminders({ project, reload }) {
  const toast = useToast()
  const [remind, setRemind] = useState(project.signoff_remind_days)
  const [escalate, setEscalate] = useState(project.signoff_escalate_days)
  const changed = Number(remind) !== project.signoff_remind_days || Number(escalate) !== project.signoff_escalate_days
  const save = async () => {
    try {
      await api(`/projects/${project.id}`, { method: 'PATCH', body: { signoff_remind_days: Number(remind), signoff_escalate_days: Number(escalate) } })
      toast('Reminder times saved')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  return (
    <div className="stack" style={{ gap: 8, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <b>When a sign-off is left waiting</b>
      <div className="row row-wrap small" style={{ gap: 8 }}>
        Remind the owner and managers after
        <input className="input input-sm" type="number" min="1" max="60" style={{ width: 64 }} value={remind} onChange={(e) => setRemind(e.target.value)} aria-label="Days before a reminder" />
        days, and tell the workspace administrators after
        <input className="input input-sm" type="number" min="1" max="120" style={{ width: 64 }} value={escalate} onChange={(e) => setEscalate(e.target.value)} aria-label="Days before escalation" />
        days.
        {changed && <button className="btn btn-primary btn-sm" onClick={save}>Save</button>}
      </div>
      <span className="hint">Overdue sign-offs are also marked in red in the bell and on the dashboard.</span>
    </div>
  )
}

const KIND_LABEL = { manual: 'Ticked by a person', all_issues_done: 'Automatic: every linked issue is done', tests_passed: 'Automatic: every test case has passed' }

/** What must be true before each stage can be signed off. */
function Criteria({ project }) {
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [type, setType] = useState('feature')
  const [draft, setDraft] = useState({ stage: '', text: '', kind: 'manual' })
  useEffect(() => {
    api(`/projects/${project.id}/signoff-criteria`).then(setRows).catch(() => setRows([]))
  }, [project.id])
  if (!rows) return <Spinner />
  const stages = (type === 'feature' ? FEATURE_STAGES : MILESTONE_STAGES).slice(0, -1)
  const stage = draft.stage || stages[0].key
  const add = (e) => {
    e.preventDefault()
    const text = draft.kind === 'manual' ? draft.text.trim() : draft.text.trim() || KIND_LABEL[draft.kind].replace('Automatic: every', 'Every')
    if (!text) return
    setRows([...rows, { target_type: type, stage, text, kind: draft.kind }])
    setDraft({ stage, text: '', kind: 'manual' })
    setDirty(true)
  }
  const save = async () => {
    try {
      setRows(await api(`/projects/${project.id}/signoff-criteria`, { method: 'PUT', body: { criteria: rows } }))
      setDirty(false)
      toast('Checklists saved')
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const mine = rows.filter((r) => r.target_type === type)
  return (
    <div className="stack" style={{ gap: 10, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div className="row between row-wrap">
        <b>Checklist for each stage</b>
        <div className="segmented">
          <button type="button" className={type === 'feature' ? 'active' : ''} onClick={() => { setType('feature'); setDraft({ stage: '', text: '', kind: 'manual' }) }}>Features</button>
          <button type="button" className={type === 'milestone' ? 'active' : ''} onClick={() => { setType('milestone'); setDraft({ stage: '', text: '', kind: 'manual' }) }}>Milestones</button>
        </div>
      </div>
      <span className="hint">A stage cannot be signed off, or even requested, until every line of its checklist is done.</span>
      {mine.length === 0 ? <span className="muted small">No checklist yet: a stage needs only the sign-off itself.</span> : stages.filter((s) => mine.some((r) => r.stage === s.key)).map((s) => (
        <div key={s.key}>
          <Badge color={s.color}>{s.label}</Badge>
          {mine.filter((r) => r.stage === s.key).map((r) => (
            <div className="row small" key={rows.indexOf(r)} style={{ gap: 8, padding: '4px 0 0 6px' }}>
              <Check size={13} className="faint" />
              <span className="grow">{r.text} {r.kind !== 'manual' && <span className="faint">({KIND_LABEL[r.kind].toLowerCase()})</span>}</span>
              {project.can_manage && <button className="btn btn-ghost btn-sm btn-icon" aria-label={`Remove ${r.text}`} onClick={() => { setRows(rows.filter((x) => x !== r)); setDirty(true) }}><X size={13} /></button>}
            </div>
          ))}
        </div>
      ))}
      {project.can_manage && (
        <form className="row row-wrap" style={{ gap: 6 }} onSubmit={add}>
          <select className="select input-sm" style={{ width: 'auto' }} value={stage} onChange={(e) => setDraft({ ...draft, stage: e.target.value })} aria-label="Stage">
            {stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <select className="select input-sm" style={{ width: 'auto' }} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} aria-label="How it is checked">
            <option value="manual">Ticked by a person</option>
            <option value="all_issues_done">Automatic: all issues done</option>
            {type === 'feature' && <option value="tests_passed">Automatic: all tests passed</option>}
          </select>
          <input className="input input-sm grow" style={{ minWidth: 160 }} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} maxLength={200} placeholder={draft.kind === 'manual' ? 'For example: design reviewed with the client' : 'Wording (optional)'} />
          <button className="btn btn-sm"><Plus size={13} /> Add</button>
          {dirty && <button type="button" className="btn btn-primary btn-sm" onClick={save}>Save checklists</button>}
        </form>
      )}
    </div>
  )
}

/** Comments and approvals that clients left on share links. */
export function ClientFeedbackCard({ project }) {
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [replying, setReplying] = useState(null)
  const [text, setText] = useState('')
  const load = () => api(`/projects/${project.id}/feedback`).then(setRows).catch(() => setRows([]))
  useEffect(() => { load() }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows || rows.length === 0) return null
  const patch = async (row, body) => {
    try {
      await api(`/feedback/${row.id}`, { method: 'PATCH', body })
      setReplying(null)
      setText('')
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const open = rows.filter((r) => !r.resolved).length
  return (
    <div className="card card-pad stack">
      <h2 className="icon-label"><MessageSquare size={17} /> <span>Client feedback {open > 0 && <span className="tag">{open} new</span>}</span></h2>
      {rows.map((r) => (
        <div className="share-row" key={r.id} style={{ alignItems: 'flex-start', opacity: r.resolved ? 0.65 : 1 }}>
          <span className="stat-icon" style={{ '--c': r.kind === 'approval' ? '#22c55e' : '#6366f1', flex: 'none' }}>{r.kind === 'approval' ? <ThumbsUp size={15} /> : <MessageSquare size={15} />}</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div><b>{r.author}</b> <span className="muted">{r.kind === 'approval' ? 'approved' : 'commented on'}</span> {r.target_type === 'project' ? 'the project' : <b>{r.target_name}</b>} <span className="faint small">· {timeAgo(r.created_at)}{r.link_label ? ` · ${r.link_label}` : ''}</span></div>
            {r.body && <div style={{ whiteSpace: 'pre-wrap' }}>{r.body}</div>}
            {r.reply && <div className="small muted" style={{ marginTop: 4 }}><b>{r.reply_by}:</b> {r.reply}</div>}
            {replying === r.id && (
              <form className="row" style={{ gap: 6, marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); patch(r, { reply: text, resolved: true }) }}>
                <input className="input input-sm grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Your reply, shown to the client on their page" autoFocus required />
                <button className="btn btn-primary btn-sm">Send</button>
              </form>
            )}
          </div>
          {project.can_approve && (
            <span className="row" style={{ gap: 4 }}>
              {!r.reply && replying !== r.id && <button className="btn btn-sm" onClick={() => { setReplying(r.id); setText('') }}>Reply</button>}
              <button className="btn btn-ghost btn-sm" onClick={() => patch(r, { resolved: !r.resolved })}>{r.resolved ? 'Reopen' : 'Done'}</button>
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

const SECTION_LABELS = { milestones: 'Milestones', features: 'Features', releases: 'Releases', issues: 'Open issues' }

function NewLinkModal({ project, onClose, onCreated }) {
  const toast = useToast()
  const [label, setLabel] = useState('')
  const [sections, setSections] = useState(['milestones', 'features', 'releases'])
  const [days, setDays] = useState('')
  const [feedback, setFeedback] = useState(true)
  const [busy, setBusy] = useState(false)
  const toggle = (key) => setSections((s) => (s.includes(key) ? s.filter((x) => x !== key) : [...s, key]))
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      onCreated(await api(`/projects/${project.id}/share-links`, { method: 'POST', body: { label, sections, expires_in_days: days ? Number(days) : null, allow_feedback: feedback } }))
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }
  return (
    <Modal title="New client link" onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <div className="modal-body stack">
          <Field label="Who is it for" hint="Only you see this name."><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="For example: Acme client team" autoFocus /></Field>
          <Field label="What they can see" as="div">
            {Object.entries(SECTION_LABELS).map(([key, text]) => (
              <label className="opt-row" key={key}><input type="checkbox" checked={sections.includes(key)} onChange={() => toggle(key)} /> {text}</label>
            ))}
            <span className="hint">Progress and dates only. Names of people, comments, documents and costs are never shown.</span>
          </Field>
          <Field label="Stops working after">
            <select className="select" value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="">Never (until you remove it)</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </Field>
          <label className="opt-row"><input type="checkbox" checked={feedback} onChange={(e) => setFeedback(e.target.checked)} /> Let them leave comments and approve milestones and features</label>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !sections.length}>{busy ? <Spinner /> : 'Create link'}</button>
        </div>
      </form>
    </Modal>
  )
}

export function ShareLinksCard({ project }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [links, setLinks] = useState(null)
  const [creating, setCreating] = useState(false)
  const load = () => api(`/projects/${project.id}/share-links`).then(setLinks).catch(() => setLinks([]))
  useEffect(() => {
    if (project.can_manage) load()
  }, [project.id, project.can_manage]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!project.can_manage) return null

  const urlOf = (link) => `${window.location.origin}/share/${link.token}`
  const copy = async (link) => {
    try {
      await navigator.clipboard.writeText(urlOf(link))
      toast('Link copied')
    } catch {
      toast('Could not copy. Select the link and copy it by hand.', 'error')
    }
  }
  const remove = async (link) => {
    if (!(await confirm({ title: 'Remove this link?', message: 'Anyone who has it will no longer be able to open the page.', confirmLabel: 'Remove link', danger: true }))) return
    try {
      await api(`/share-links/${link.id}`, { method: 'DELETE' })
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div className="card card-pad stack">
      <div className="row between row-wrap">
        <h2 className="icon-label"><Link2 size={17} /> <span>Client access</span></h2>
        <button className="btn btn-sm" onClick={() => setCreating(true)}><Plus size={14} /> New link</button>
      </div>
      <p className="muted small">Give a client a private link to a read-only progress page. They need no account and use no seat.</p>
      {!links ? <Spinner /> : links.length === 0 ? <span className="muted small">No links yet.</span> : links.map((link) => (
        <div className="share-row" key={link.id}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{link.label || 'Client link'} {link.expired && <span className="danger-text small">· expired</span>}</div>
            <div className="small muted truncate">{urlOf(link)}</div>
            <div className="small faint">
              {link.sections.map((s) => SECTION_LABELS[s]).join(', ')}{link.allow_feedback ? ', comments' : ''} · <Eye size={11} style={{ verticalAlign: -1 }} /> {link.views} {link.views === 1 ? 'view' : 'views'}
              {link.last_viewed_at ? `, last ${timeAgo(link.last_viewed_at)}` : ''}
              {link.expires_at ? ` · until ${formatDate(link.expires_at, true)}` : ''}
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => copy(link)}><Copy size={13} /> Copy</button>
          <button className="btn btn-ghost btn-sm btn-icon danger-text" onClick={() => remove(link)} aria-label="Remove link"><Trash2 size={14} /></button>
        </div>
      ))}
      {creating && <NewLinkModal project={project} onClose={() => setCreating(false)} onCreated={(link) => { setCreating(false); load(); copy(link) }} />}
    </div>
  )
}
