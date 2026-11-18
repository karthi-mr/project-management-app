import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Bot, Check, ChevronRight, Send, Sparkles, Trash2, X } from 'lucide-react'
import { api, notifyChanged } from '../api'
import { Field, PRIORITIES, Spinner, TYPES, useOpenIssue } from '../ui'

/* The free assistant: a chat panel that answers everyday questions from the workspace's own data
 * (no AI model, nothing leaves Trackly) and drafts actions that only happen when you confirm. */

const KEY = 'pm_assistant'
const FIRST = [
  { from: 'bot', text: 'Hi! I answer questions about your projects and can draft issues, time entries and sign-off requests for you. Nothing changes until you confirm.', suggestions: ['What is waiting for me?', 'My work', 'Overdue', 'Help'] },
]

function load() {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(KEY) || 'null')
    return Array.isArray(saved) && saved.length ? saved : FIRST
  } catch {
    return FIRST
  }
}

function save(messages) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(messages.slice(-40)))
  } catch {
    /* private window: the conversation just isn't kept */
  }
}

const todayISO = () => {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

function CreateIssueCard({ action, onDone }) {
  const { projects } = action.options
  const [form, setForm] = useState({ ...action.fields })
  const [busy, setBusy] = useState(false)
  const project = projects.find((p) => p.id === Number(form.project_id))
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })
  const confirm = async () => {
    setBusy(true)
    try {
      const issue = await api('/issues', {
        method: 'POST',
        body: {
          project_id: Number(form.project_id), title: form.title.trim(), type: form.type, priority: form.priority,
          assignee_id: form.assignee_id ? Number(form.assignee_id) : null, due_date: form.due_date || null,
          feature_id: form.feature_id ? Number(form.feature_id) : null,
        },
      })
      notifyChanged()
      onDone({ text: `Created ${issue.key}: ${issue.title}.`, items: [{ type: 'issue', id: issue.id, project_id: issue.project_id, title: `${issue.key} ${issue.title}`, badge: 'created' }] })
    } catch (err) {
      onDone({ text: `Could not create it: ${err.message}`, error: true }, true)
      setBusy(false)
    }
  }
  return (
    <div className="assistant-action">
      <Field label="Title"><input className="input input-sm" value={form.title} onChange={set('title')} maxLength={200} aria-label="Issue title" /></Field>
      <div className="assistant-grid">
        <Field label="Project">
          <select className="select input-sm" value={form.project_id || ''} onChange={(e) => setForm({ ...form, project_id: e.target.value, assignee_id: '', feature_id: '' })} aria-label="Project">
            <option value="">Choose…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select className="select input-sm" value={form.type} onChange={set('type')}>{TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
        </Field>
        <Field label="Assignee">
          <select className="select input-sm" value={form.assignee_id || ''} onChange={set('assignee_id')} aria-label="Assignee">
            <option value="">Nobody yet</option>
            {(project?.people || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select className="select input-sm" value={form.priority} onChange={set('priority')}>{PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
        </Field>
        <Field label="Due"><input className="input input-sm" type="date" value={form.due_date || ''} onChange={set('due_date')} aria-label="Due date" /></Field>
        <Field label="Feature">
          <select className="select input-sm" value={form.feature_id || ''} onChange={set('feature_id')}>
            <option value="">None</option>
            {(project?.features || []).map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
          </select>
        </Field>
      </div>
      <ActionButtons busy={busy} disabled={!form.title?.trim() || !form.project_id} label="Create issue" onConfirm={confirm} onCancel={() => onDone({ text: 'Cancelled. Nothing was created.' })} />
    </div>
  )
}

function LogTimeCard({ action, onDone }) {
  const [form, setForm] = useState({ ...action.fields })
  const [busy, setBusy] = useState(false)
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })
  const confirm = async () => {
    setBusy(true)
    const path = form.target_type === 'feature' ? `/features/${form.target_id}/time` : `/issues/${form.target_id}/time`
    try {
      await api(path, { method: 'POST', body: { day: form.day, hours: Number(form.hours), note: form.note } })
      notifyChanged()
      onDone({ text: `Logged ${Number(form.hours)}h on ${form.target_label}.` })
    } catch (err) {
      onDone({ text: `Could not log it: ${err.message}`, error: true }, true)
      setBusy(false)
    }
  }
  return (
    <div className="assistant-action">
      <div className="small"><b>{form.target_label}</b></div>
      <div className="assistant-grid">
        <Field label="Hours"><input className="input input-sm" type="number" min="0.25" max="24" step="0.25" value={form.hours} onChange={set('hours')} aria-label="Hours" /></Field>
        <Field label="Day"><input className="input input-sm" type="date" value={form.day} max={todayISO()} onChange={set('day')} aria-label="Day" /></Field>
      </div>
      <Field label="Note"><input className="input input-sm" value={form.note} maxLength={300} onChange={set('note')} placeholder="What did you work on?" /></Field>
      <ActionButtons busy={busy} disabled={!(Number(form.hours) > 0)} label="Log time" onConfirm={confirm} onCancel={() => onDone({ text: 'Cancelled. No time was logged.' })} />
    </div>
  )
}

function SignoffCard({ action, onDone }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const f = action.fields
  const confirm = async () => {
    setBusy(true)
    try {
      await api(`/projects/${f.project_id}/signoffs`, { method: 'POST', body: { target_type: f.target_type, target_id: f.target_id, note } })
      notifyChanged()
      onDone({ text: `Sign-off requested for ${f.label}. The owner and all managers have been asked.` })
    } catch (err) {
      onDone({ text: `Could not request it: ${err.message}`, error: true }, true)
      setBusy(false)
    }
  }
  return (
    <div className="assistant-action">
      <div className="small"><b>{f.label}</b> · {f.stage} → {f.to_stage}</div>
      <Field label="Note (optional)"><input className="input input-sm" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Anything the approvers should know" /></Field>
      <ActionButtons busy={busy} label="Send request" onConfirm={confirm} onCancel={() => onDone({ text: 'Cancelled. No request was sent.' })} />
    </div>
  )
}

function ActionButtons({ busy, disabled, label, onConfirm, onCancel }) {
  return (
    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="button" className="btn btn-sm btn-primary" onClick={onConfirm} disabled={busy || disabled}>{busy ? <Spinner /> : <><Check size={13} /> {label}</>}</button>
    </div>
  )
}

const CARDS = { create_issue: CreateIssueCard, log_time: LogTimeCard, request_signoff: SignoffCard }

export default function Assistant() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState(load)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const scroller = useRef(null)
  const input = useRef(null)
  const location = useLocation()
  const navigate = useNavigate()
  const openIssue = useOpenIssue()
  const projectId = Number(location.pathname.match(/^\/projects\/(\d+)/)?.[1]) || null

  useEffect(() => save(messages), [messages])
  useEffect(() => {
    if (open) {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
      input.current?.focus()
    }
  }, [open, messages.length])
  useEffect(() => {
    // Ctrl/⌘ + J opens and closes the assistant.
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const ask = async (question) => {
    const q = question.trim()
    if (!q || busy) return
    setText('')
    setMessages((m) => [...m, { from: 'me', text: q }])
    setBusy(true)
    try {
      const answer = await api('/assistant', { method: 'POST', body: { text: q, project_id: projectId } })
      setMessages((m) => [...m, { from: 'bot', ...answer, actionState: answer.action ? 'open' : undefined }])
    } catch (err) {
      setMessages((m) => [...m, { from: 'bot', text: err.message, error: true }])
    }
    setBusy(false)
  }

  const finishAction = (index) => (result, keepOpen = false) => {
    setMessages((m) => {
      const next = m.map((msg, n) => (n === index && !keepOpen ? { ...msg, actionState: 'done' } : msg))
      return [...next, { from: 'bot', ...result }]
    })
  }

  const openItem = (item) => {
    const base = `/projects/${item.project_id}`
    if (item.type === 'issue') openIssue(item.id)
    else if (item.type === 'feature') navigate(`${base}?tab=features&feature=${item.id}`)
    else if (item.type === 'module') navigate(`${base}?tab=modules`)
    else if (item.type === 'milestone') navigate(`${base}?tab=milestones`)
    else if (item.type === 'approval') navigate(`${base}?tab=approvals`)
    else if (item.type === 'project') navigate(base)
  }

  return (
    <>
      {!open && (
        <button type="button" className="assistant-fab" onClick={() => setOpen(true)} aria-label="Open the assistant" title="Assistant (Ctrl+J)">
          <Bot size={22} />
        </button>
      )}
      {open && (
        <section className="assistant" role="dialog" aria-label="Assistant">
          <header className="assistant-head">
            <span className="assistant-avatar"><Sparkles size={15} /></span>
            <div className="grow">
              <b>Assistant</b>
              <div className="faint small">Answers from your projects · free</div>
            </div>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" title="Clear the conversation" aria-label="Clear the conversation" onClick={() => setMessages(FIRST)}><Trash2 size={15} /></button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Close the assistant" onClick={() => setOpen(false)}><X size={17} /></button>
          </header>
          <div className="assistant-body" ref={scroller}>
            {messages.map((m, index) => {
              const Card = m.action && CARDS[m.action.type]
              return (
                <div key={index} className={`assistant-msg ${m.from} ${m.error ? 'error' : ''}`}>
                  <div className="assistant-bubble">
                    <div>{m.text}</div>
                    {m.stats?.length > 0 && (
                      <div className="assistant-stats">
                        {m.stats.map((s) => <div key={s.label}><b>{s.value}</b><span>{s.label}</span></div>)}
                      </div>
                    )}
                    {m.items?.length > 0 && (
                      <div className="assistant-items">
                        {m.items.map((item) => (
                          <button type="button" key={`${item.type}${item.id}`} className={`assistant-item ${item.late ? 'late' : ''}`} onClick={() => openItem(item)} disabled={item.type === 'person'}>
                            <span className="grow">
                              <span className="assistant-item-title">{item.title}</span>
                              {item.subtitle && <span className="faint small">{item.subtitle}</span>}
                            </span>
                            {item.badge && <span className="tag">{item.badge}</span>}
                            {item.type !== 'person' && <ChevronRight size={14} className="faint" />}
                          </button>
                        ))}
                      </div>
                    )}
                    {m.help?.length > 0 && (
                      <div className="assistant-items">
                        {m.help.map((h) => (
                          <button type="button" key={h.example} className="assistant-item" onClick={() => { setText(h.example.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() + ' '); input.current?.focus() }}>
                            <span className="grow"><span className="assistant-item-title">{h.example}</span><span className="faint small">{h.meaning}</span></span>
                          </button>
                        ))}
                      </div>
                    )}
                    {Card && m.actionState === 'open' && <Card action={m.action} onDone={finishAction(index)} />}
                  </div>
                  {m.suggestions?.length > 0 && index === messages.length - 1 && (
                    <div className="assistant-chips">
                      {m.suggestions.map((s) => <button type="button" key={s} className="chip" onClick={() => ask(s)}>{s}</button>)}
                    </div>
                  )}
                </div>
              )
            })}
            {busy && <div className="assistant-msg bot"><div className="assistant-bubble"><Spinner /></div></div>}
          </div>
          <form className="assistant-input" onSubmit={(e) => { e.preventDefault(); ask(text) }}>
            <input ref={input} className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask, e.g. “overdue in Mobile App”" aria-label="Ask the assistant" maxLength={500} />
            <button className="btn btn-primary btn-icon" disabled={!text.trim() || busy} aria-label="Send"><Send size={16} /></button>
          </form>
        </section>
      )}
    </>
  )
}
