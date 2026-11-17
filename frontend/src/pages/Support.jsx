import { useCallback, useEffect, useState } from 'react'
import { LifeBuoy, Plus, Send } from 'lucide-react'
import { api } from '../api'
import { useToast } from '../context'
import { Badge, Empty, Field, Modal, PageSkeleton, Spinner, timeAgo } from '../ui'

export const TICKET_STATUS = {
  open: { label: 'Waiting for support', staffLabel: 'Needs a reply', color: '#f59e0b' },
  answered: { label: 'Answered', staffLabel: 'Answered', color: '#22c55e' },
  closed: { label: 'Closed', staffLabel: 'Closed', color: '#94a3b8' },
}

/** One conversation. `base` is the API path prefix: "/support/tickets" or "/platform/support". */
export function TicketThread({ ticketId, base, staff = false, onClose, onChanged }) {
  const toast = useToast()
  const [ticket, setTicket] = useState(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api(`${base}/${ticketId}`).then(setTicket).catch((e) => toast(e.message, 'error'))
  }, [base, ticketId, toast])

  const send = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      setTicket(await api(`${base}/${ticketId}/reply`, { method: 'POST', body: { body } }))
      setBody('')
      onChanged?.()
    } catch (err) {
      toast(err.message, 'error')
    }
    setBusy(false)
  }
  const setStatus = async (status) => {
    try {
      setTicket(staff
        ? await api(`${base}/${ticketId}/status`, { method: 'POST', body: { status } })
        : await api(`${base}/${ticketId}/close`, { method: 'POST' }))
      onChanged?.()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <Modal title={ticket ? ticket.subject : 'Conversation'} onClose={onClose}>
      {!ticket ? <div className="modal-body"><Spinner /></div> : (
        <form onSubmit={send}>
          <div className="modal-body stack">
            <div className="row row-wrap small muted" style={{ gap: 8 }}>
              <Badge color={TICKET_STATUS[ticket.status].color}>{staff ? TICKET_STATUS[ticket.status].staffLabel : TICKET_STATUS[ticket.status].label}</Badge>
              {staff && <span>{ticket.org_name} · {ticket.user_name}</span>}
            </div>
            <div className="thread">
              {ticket.messages.map((m) => (
                <div key={m.id} className={`thread-msg ${m.from_staff === staff ? 'mine' : ''}`}>
                  <div className="small faint">{m.from_staff ? 'Support' : m.author} · {timeAgo(m.created_at)}</div>
                  <div className="thread-body">{m.body}</div>
                </div>
              ))}
            </div>
            {ticket.status !== 'closed' || staff ? (
              <Field label="Reply"><textarea className="textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} required /></Field>
            ) : <p className="muted small">This conversation is closed. Start a new one if you need more help.</p>}
          </div>
          <div className="modal-footer">
            {ticket.status !== 'closed'
              ? <button type="button" className="btn btn-ghost" style={{ marginRight: 'auto' }} onClick={() => setStatus('closed')}>{staff ? 'Close conversation' : 'Mark as solved'}</button>
              : staff && <button type="button" className="btn btn-ghost" style={{ marginRight: 'auto' }} onClick={() => setStatus('open')}>Reopen</button>}
            <button type="button" className="btn" onClick={onClose}>Close</button>
            {(ticket.status !== 'closed' || staff) && <button className="btn btn-primary" disabled={busy || !body.trim()}>{busy ? <Spinner /> : <><Send size={14} /> Send</>}</button>}
          </div>
        </form>
      )}
    </Modal>
  )
}

function NewTicketModal({ onClose, onCreated }) {
  const toast = useToast()
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      onCreated(await api('/support/tickets', { method: 'POST', body: { subject, body } }))
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }
  return (
    <Modal title="Ask for help" onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <div className="modal-body stack">
          <Field label="Subject"><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} minLength={3} maxLength={200} required autoFocus /></Field>
          <Field label="How can we help?" hint="Say what you were doing and what happened."><textarea className="textarea" rows={5} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} required /></Field>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Send'}</button>
        </div>
      </form>
    </Modal>
  )
}

export default function Support() {
  const [data, setData] = useState(null)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState(null)
  const load = useCallback(() => api('/support/tickets').then(setData).catch(() => setData({ tickets: [] })), [])
  useEffect(() => { load() }, [load])
  if (!data) return <div className="page"><PageSkeleton variant="list" padded={false} /></div>
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Help and support</h1>
          <p>Ask our team a question. You are told here and in the bell when we reply.{data.support_email ? ` You can also write to ${data.support_email}.` : ''}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> New question</button>
      </div>
      <div className="card">
        {data.tickets.length === 0 ? (
          <Empty icon={LifeBuoy} title="No questions yet">Anything unclear or not working? Send us a message.</Empty>
        ) : data.tickets.map((t) => (
          <button className="list-row" key={t.id} onClick={() => setOpen(t.id)}>
            <span className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{t.subject}</div>
              <div className="small muted truncate">{t.last_from_staff ? 'Support: ' : ''}{t.preview}</div>
            </span>
            <span className="small faint hide-mobile">{t.user_name} · {timeAgo(t.updated_at)}</span>
            <Badge color={TICKET_STATUS[t.status].color}>{TICKET_STATUS[t.status].label}</Badge>
          </button>
        ))}
      </div>
      {creating && <NewTicketModal onClose={() => setCreating(false)} onCreated={(t) => { setCreating(false); load(); setOpen(t.id) }} />}
      {open && <TicketThread ticketId={open} base="/support/tickets" onClose={() => { setOpen(null); load() }} onChanged={load} />}
    </div>
  )
}
