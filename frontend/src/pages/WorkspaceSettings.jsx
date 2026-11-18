import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CreditCard, LayoutGrid, ShieldCheck } from 'lucide-react'
import { api } from '../api'
import { useAuth, useToast } from '../context'
import { PageSkeleton, Spinner } from '../ui'
import WorkspaceIdCard from '../components/WorkspaceIdCard'

const HINTS = {
  sprints: 'Time-boxed iterations on the Work tab.',
  tests: 'Test cases and test runs per feature.',
  documents: 'Project documents and specs.',
  risks: 'A risk register per project.',
  time: 'Logging hours on issues, and the Timesheet page.',
  budgets: 'Project budgets and costs from logged time.',
  portfolio: 'All projects side by side, for managers.',
  workload: 'Who has too much or too little planned.',
  chat: 'Direct and group messages.',
  automation: 'Rules that act on issues automatically.',
  client_access: 'Read-only links and feedback from clients.',
  assistant: 'A chat helper that answers questions about projects and drafts issues, time and sign-off requests. Free.',
}

/** Workspace administrators: choose which optional parts of the app people see. */
export default function WorkspaceSettings() {
  const { refresh } = useAuth()
  const toast = useToast()
  const [modules, setModules] = useState(null)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    api('/admin/modules').then(setModules).catch((e) => toast(e.message, 'error'))
  }, [toast])

  const toggle = async (m) => {
    setBusy(m.key)
    try {
      setModules(await api('/admin/modules', { method: 'PUT', body: { modules: { [m.key]: !m.on } } }))
      await refresh()
      toast(`${m.label} ${m.on ? 'hidden' : 'shown'} for everyone`)
    } catch (err) {
      toast(err.message, 'error')
    }
    setBusy('')
  }

  if (!modules) return <div className="page"><PageSkeleton variant="list" padded={false} /></div>
  const on = modules.filter((m) => m.on).length
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Workspace settings</h1>
          <p>Keep the app as simple as your team needs.</p>
        </div>
      </div>
      <div style={{ maxWidth: 820, marginBottom: 16 }}>
        <WorkspaceIdCard admin />
      </div>
      <div className="card card-pad stack" style={{ maxWidth: 820 }}>
        <div className="row between row-wrap">
          <h2 className="icon-label"><LayoutGrid size={17} /> <span>Optional tools</span></h2>
          <span className="small muted">{on} of {modules.length} switched on</span>
        </div>
        <p className="muted small">
          Projects, features, milestones, issues, releases, approvals, the board, roadmap and calendar are always there.
          Switching a module off hides it for everyone in the workspace; nothing is deleted, and switching it back on
          shows everything again. Some modules also need a plan that includes them.
        </p>
        <div className="module-list">
          {modules.map((m) => (
            <label className={`module-row ${m.on ? 'on' : ''}`} key={m.key}>
              <span className="grow">
                <b>{m.label}</b>
                <span className="small muted">{HINTS[m.key]}</span>
              </span>
              {busy === m.key ? <Spinner /> : (
                <span className="switch">
                  <input type="checkbox" checked={m.on} onChange={() => toggle(m)} aria-label={`${m.label}: ${m.on ? 'on' : 'off'}`} />
                  <i />
                </span>
              )}
            </label>
          ))}
        </div>
      </div>
      <div className="row row-wrap" style={{ gap: 10, marginTop: 16 }}>
        <Link className="btn" to="/users?tab=security"><ShieldCheck size={15} /> Security and sign-in rules</Link>
        <Link className="btn" to="/billing"><CreditCard size={15} /> Name, logo and plan</Link>
      </div>
    </div>
  )
}
