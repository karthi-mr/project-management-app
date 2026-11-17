import { useCallback, useEffect, useState } from 'react'
import { Ban, Bug, Check, FlaskConical, History, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { api, notifyChanged } from '../api'
import { useConfirm, useToast } from '../context'
import { Badge, Empty, Field, Modal, Spinner, timeAgo, useOpenIssue } from '../ui'

const STATUS = {
  '': { label: 'Not run', color: '#94a3b8' },
  passed: { label: 'Passed', color: '#22c55e' },
  failed: { label: 'Failed', color: '#ef4444' },
  blocked: { label: 'Blocked', color: '#f59e0b' },
}

function CaseModal({ project, features, existing, defaultFeature, onClose, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState({
    title: existing?.title || '', steps: existing?.steps || '', expected: existing?.expected || '',
    feature_id: existing ? existing.feature_id || '' : defaultFeature || '',
  })
  const [busy, setBusy] = useState(false)
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const body = { ...form, feature_id: form.feature_id ? Number(form.feature_id) : null }
      await api(existing ? `/tests/${existing.id}` : `/projects/${project.id}/tests`, { method: existing ? 'PATCH' : 'POST', body })
      toast(existing ? 'Test case saved' : 'Test case added')
      onSaved()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }
  return (
    <Modal title={existing ? 'Edit test case' : 'New test case'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body stack">
          <Field label="What is being checked"><input className="input" value={form.title} onChange={set('title')} maxLength={200} placeholder="For example: a wrong password is rejected" required autoFocus /></Field>
          <Field label="Feature">
            <select className="select" value={form.feature_id} onChange={set('feature_id')}>
              <option value="">No feature (general test)</option>
              {features.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
            </select>
          </Field>
          <Field label="Steps"><textarea className="textarea" rows={4} value={form.steps} onChange={set('steps')} placeholder={'1. Open the sign-in page\n2. Enter a wrong password\n3. Press Sign in'} /></Field>
          <Field label="Expected result"><textarea className="textarea" rows={2} value={form.expected} onChange={set('expected')} placeholder="An error is shown and the person stays signed out" /></Field>
          {existing?.status && <span className="hint">Changing the steps or the expected result sets this case back to “Not run”.</span>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

function ResultModal({ testCase, status, onClose, onSaved }) {
  const toast = useToast()
  const [note, setNote] = useState('')
  const [bug, setBug] = useState(true)
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const result = await api(`/tests/${testCase.id}/results`, { method: 'POST', body: { status, note, raise_bug: status === 'failed' && bug } })
      toast(status === 'failed' && result.bug_issue_id ? 'Marked as failed and a bug was raised' : `Marked as ${status}`)
      onSaved()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }
  return (
    <Modal title={`${status === 'failed' ? 'Failed' : 'Blocked'}: ${testCase.title}`} onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <div className="modal-body stack">
          <Field label={status === 'failed' ? 'What happened instead' : 'What is blocking the test'}>
            <textarea className="textarea" rows={4} value={note} onChange={(e) => setNote(e.target.value)} required autoFocus />
          </Field>
          {status === 'failed' && (
            <label className="opt-row">
              <input type="checkbox" checked={bug} onChange={(e) => setBug(e.target.checked)} />
              Raise a bug for it{testCase.feature_title ? ', assigned to the feature owner' : ''}
            </label>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className={`btn ${status === 'failed' ? 'btn-danger' : 'btn-primary'}`} disabled={busy}>{busy ? <Spinner /> : 'Save result'}</button>
        </div>
      </form>
    </Modal>
  )
}

function HistoryModal({ caseId, onClose }) {
  const openIssue = useOpenIssue()
  const [data, setData] = useState(null)
  useEffect(() => { api(`/tests/${caseId}`).then(setData).catch(() => onClose()) }, [caseId]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title={data ? data.title : 'Test case'} onClose={onClose}>
      <div className="modal-body stack">
        {!data ? <Spinner /> : (
          <>
            {data.steps && <div><div className="section-title">Steps</div><div style={{ whiteSpace: 'pre-wrap' }}>{data.steps}</div></div>}
            {data.expected && <div><div className="section-title">Expected result</div><div style={{ whiteSpace: 'pre-wrap' }}>{data.expected}</div></div>}
            <div>
              <div className="section-title">Runs</div>
              {data.results.length === 0 ? <span className="muted">Not run yet.</span> : data.results.map((r) => (
                <div className="time-row" key={r.id} style={{ alignItems: 'flex-start' }}>
                  <Badge color={STATUS[r.status].color}>{STATUS[r.status].label}</Badge>
                  <span className="grow">
                    <span className="small muted">{r.tester} · {timeAgo(r.created_at)}</span>
                    {r.note && <div style={{ whiteSpace: 'pre-wrap' }}>{r.note}</div>}
                  </span>
                  {r.issue_id && <button className="btn btn-sm" onClick={() => { onClose(); openIssue(r.issue_id) }}><Bug size={13} /> Bug</button>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="modal-footer"><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  )
}

export default function Tests({ project, features }) {
  const toast = useToast()
  const confirm = useConfirm()
  const openIssue = useOpenIssue()
  const [data, setData] = useState(null)
  const [featureId, setFeatureId] = useState('')
  const [status, setStatus] = useState('all')
  const [editing, setEditing] = useState(null)
  const [failing, setFailing] = useState(null) // { testCase, status }
  const [history, setHistory] = useState(null)
  const canEdit = project.can_edit

  const load = useCallback(() => api(`/projects/${project.id}/tests`).then(setData).catch(() => setData({ cases: [], summary: {} })), [project.id])
  useEffect(() => { load() }, [load])
  const changed = () => { load(); notifyChanged() }

  const pass = async (c) => {
    try {
      await api(`/tests/${c.id}/results`, { method: 'POST', body: { status: 'passed' } })
      changed()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const remove = async (c) => {
    if (!(await confirm({ title: `Delete “${c.title}”?`, message: 'The test case and its run history are removed.', confirmLabel: 'Delete', danger: true }))) return
    try {
      await api(`/tests/${c.id}`, { method: 'DELETE' })
      changed()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const reset = async () => {
    const scope = featureId ? 'the test cases of this feature' : 'every test case in the project'
    if (!(await confirm({ title: 'Start a new test round?', message: `This sets ${scope} back to “Not run”. Earlier runs stay in the history.`, confirmLabel: 'Start new round' }))) return
    try {
      await api(`/projects/${project.id}/tests/reset${featureId ? `?feature_id=${featureId}` : ''}`, { method: 'POST' })
      toast('New test round started')
      changed()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  if (!data) return <Spinner />
  const scoped = data.cases.filter((c) => !featureId || String(c.feature_id || 'none') === featureId)
  const count = (key) => scoped.filter((c) => c.status === key).length
  const shown = scoped.filter((c) => status === 'all' || c.status === status)
  const total = scoped.length
  const passedShare = total ? Math.round((count('passed') / total) * 100) : 0
  const groups = []
  shown.forEach((c) => {
    const key = c.feature_title || 'General tests'
    const group = groups.find((g) => g.key === key) || groups[groups.push({ key, cases: [] }) - 1]
    group.cases.push(c)
  })

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <select className="select" value={featureId} onChange={(e) => setFeatureId(e.target.value)} aria-label="Feature">
          <option value="">All features</option>
          {features.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
          <option value="none">General tests</option>
        </select>
        <div className="segmented">
          {[['all', `All ${total}`], ['', `Not run ${count('')}`], ['passed', `Passed ${count('passed')}`], ['failed', `Failed ${count('failed')}`], ['blocked', `Blocked ${count('blocked')}`]].map(([key, label]) => (
            <button key={key} className={status === key ? 'active' : ''} onClick={() => setStatus(key)}>{label}</button>
          ))}
        </div>
        <span className="grow" />
        {canEdit && total > 0 && <button className="btn" onClick={reset}><RotateCcw size={14} /> New test round</button>}
        {canEdit && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> New test case</button>}
      </div>

      {total > 0 && (
        <div className="card card-pad stack" style={{ gap: 8 }}>
          <div className="row between"><b>{count('passed')} of {total} passed</b><span className="muted small">{count('failed')} failed · {count('blocked')} blocked · {count('')} not run</span></div>
          <div className="test-bar" role="img" aria-label={`${passedShare}% passed`}>
            {['passed', 'failed', 'blocked', ''].map((key) => count(key) > 0 && <i key={key} style={{ width: `${(count(key) / total) * 100}%`, background: STATUS[key].color }} title={`${STATUS[key].label}: ${count(key)}`} />)}
          </div>
        </div>
      )}

      {data.cases.length === 0 ? (
        <div className="card">
          <Empty icon={FlaskConical} title="No test cases yet" action={canEdit && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> New test case</button>}>
            Write down what has to be checked for each feature. Testers mark each case as passed or failed, and a failed case can raise a bug in one step.
          </Empty>
        </div>
      ) : shown.length === 0 ? (
        <div className="card"><Empty icon={FlaskConical} title="No test cases match" /></div>
      ) : groups.map((group) => (
        <div className="card" key={group.key}>
          <div className="card-header"><h2>{group.key}</h2><span className="muted small">{group.cases.filter((c) => c.status === 'passed').length}/{group.cases.length} passed</span></div>
          {group.cases.map((c) => (
            <div className="list-row test-row" key={c.id} style={{ cursor: 'default', alignItems: 'flex-start' }}>
              <span className="grow" style={{ minWidth: 0 }}>
                <button className="link-btn" style={{ color: 'var(--text)', textAlign: 'left' }} onClick={() => setHistory(c.id)}>{c.title}</button>
                {c.expected && <div className="small muted truncate">Expected: {c.expected}</div>}
                {c.status && <div className="small faint">{c.last_run_by} · {timeAgo(c.last_run_at)}{c.last_note ? ` · ${c.last_note}` : ''}</div>}
              </span>
              <Badge color={STATUS[c.status].color}>{STATUS[c.status].label}</Badge>
              {c.bug_issue_id && <button className="btn btn-sm" onClick={() => openIssue(c.bug_issue_id)} title="Open the bug raised from this test"><Bug size={13} /> Bug</button>}
              {canEdit && (
                <span className="row" style={{ gap: 2 }}>
                  <button className="btn btn-sm test-pass" onClick={() => pass(c)} title="Passed"><Check size={14} /> Pass</button>
                  <button className="btn btn-sm test-fail" onClick={() => setFailing({ testCase: c, status: 'failed' })} title="Failed"><X size={14} /> Fail</button>
                  <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setFailing({ testCase: c, status: 'blocked' })} title="Blocked: cannot be tested right now" aria-label="Blocked"><Ban size={14} /></button>
                  <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setHistory(c.id)} title="Steps and history" aria-label="Steps and history"><History size={14} /></button>
                  <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setEditing(c)} aria-label={`Edit ${c.title}`}><Pencil size={14} /></button>
                  <button className="btn btn-ghost btn-sm btn-icon danger-text" onClick={() => remove(c)} aria-label={`Delete ${c.title}`}><Trash2 size={14} /></button>
                </span>
              )}
            </div>
          ))}
        </div>
      ))}

      {editing && <CaseModal project={project} features={features} existing={editing === 'new' ? null : editing} defaultFeature={featureId && featureId !== 'none' ? featureId : ''} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); changed() }} />}
      {failing && <ResultModal {...failing} onClose={() => setFailing(null)} onSaved={() => { setFailing(null); changed() }} />}
      {history && <HistoryModal caseId={history} onClose={() => setHistory(null)} />}
    </div>
  )
}
