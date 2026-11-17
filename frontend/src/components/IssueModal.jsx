import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Repeat, Send, Trash2, X } from 'lucide-react'
import { RichEditor, RichText } from './RichText'
import { CustomFields, TimeLog } from './IssueExtras'
import { WatchButton } from './ProjectRules'
import { api, notifyChanged } from '../api'
import { useAuth, useConfirm, useToast } from '../context'
import { useUndoDelete } from './useUndo'
import {
  Avatar,
  Field,
  Modal,
  PRIORITIES,
  Progress,
  RECURRENCES,
  statusesOf,
  Spinner,
  TYPES,
  TypeIcon,
  formatDate,
  timeAgo,
} from '../ui'

export default function IssueModal({ issueId, onClose }) {
  const { user } = useAuth()
  const toast = useToast()
  const undo = useUndoDelete()
  const confirm = useConfirm()
  const [issue, setIssue] = useState(null)
  const [project, setProject] = useState(null)
  const [milestones, setMilestones] = useState([])
  const [siblings, setSiblings] = useState([])
  const [sprints, setSprints] = useState([])
  const [features, setFeatures] = useState([])
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [editingDescription, setEditingDescription] = useState(false)
  const [comment, setComment] = useState('')
  const [labelDraft, setLabelDraft] = useState('')
  const [checkDraft, setCheckDraft] = useState('')
  const [posting, setPosting] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api(`/issues/${issueId}`)
      setIssue(data)
      setTitle(data.title)
      setDescription(data.description)
      return data
    } catch (err) {
      setError(err.message)
      return null
    }
  }, [issueId])

  useEffect(() => {
    load().then((data) => {
      if (!data) return
      api(`/issues?project_id=${data.project_id}&limit=1000`).then(setSiblings).catch(() => {})
      api(`/projects/${data.project_id}`)
        .then((p) => {
          setProject(p)
          // Only ask for the parts of the project this person is allowed to see.
          if (p.sections.includes('milestones')) api(`/projects/${p.id}/milestones`).then(setMilestones).catch(() => {})
          if (p.sections.includes('features')) api(`/projects/${p.id}/features`).then(setFeatures).catch(() => {})
          api(`/projects/${p.id}/sprints`).then(setSprints).catch(() => {})
        })
        .catch(() => {})
    })
  }, [load])

  const patch = async (changes) => {
    try {
      await api(`/issues/${issueId}`, { method: 'PATCH', body: changes })
      await load()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
      load()
    }
  }

  const saveTitle = () => {
    const clean = title.trim()
    if (!clean) return setTitle(issue.title)
    if (clean !== issue.title) patch({ title: clean })
  }

  const saveDescription = () => {
    if (description !== issue.description) patch({ description })
  }

  const addLabel = () => {
    const label = labelDraft.trim().toLowerCase()
    setLabelDraft('')
    if (label && !issue.labels.includes(label)) patch({ labels: [...issue.labels, label] })
  }

  const checklistCall = async (path, options) => {
    try {
      await api(path, options)
      await load()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const addCheck = (e) => {
    e.preventDefault()
    const text = checkDraft.trim()
    if (!text) return
    setCheckDraft('')
    checklistCall(`/issues/${issueId}/checklist`, { method: 'POST', body: { text } })
  }

  const postComment = async (e) => {
    e.preventDefault()
    if (!comment.trim()) return
    setPosting(true)
    try {
      await api(`/issues/${issueId}/comments`, { method: 'POST', body: { body: comment } })
      setComment('')
      await load()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setPosting(false)
    }
  }

  const removeComment = async (id) => {
    try {
      await api(`/comments/${id}`, { method: 'DELETE' })
      await load()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${issue.key}?`,
      message: 'It moves to the recycle bin for 30 days, with its comments, checklist and time.',
      confirmLabel: 'Delete issue',
      danger: true,
    })
    if (!ok) return
    try {
      await api(`/issues/${issueId}`, { method: 'DELETE' })
      undo('issue', issue.id, issue.key)
      notifyChanged()
      onClose()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  if (error) {
    return (
      <Modal title="Issue unavailable" onClose={onClose} size="sm">
        <div className="modal-body">
          <p className="muted">{error}</p>
        </div>
      </Modal>
    )
  }

  if (!issue) {
    return (
      <Modal title="Loading…" onClose={onClose} size="lg">
        <Spinner page />
      </Modal>
    )
  }

  const canDelete = project?.can_manage || issue.reporter?.id === user.id
  const header = (
    <span className="row" style={{ gap: 8 }}>
      <TypeIcon type={issue.type} />
      <Link to={`/projects/${issue.project_id}`} onClick={onClose} className="muted" style={{ fontWeight: 550, fontSize: 13.5 }}>
        {issue.project_name}
      </Link>
      <span className="faint">/</span>
      <span className="issue-key" style={{ fontSize: 13.5 }}>{issue.key}</span>
      {issue.recurrence && <span className="tag"><Repeat size={11} /> {issue.recurrence}</span>}
      <span style={{ marginLeft: 6 }}><WatchButton kind="issue" id={issue.id} /></span>
    </span>
  )

  return (
    <Modal title={header} onClose={onClose} size="lg">
      <fieldset className="plain-fieldset" disabled={Boolean(project) && !project.can_edit}>
      <div className="issue-detail">
        <div className="issue-main">
          <textarea
            className="title-input"
            rows={1}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))}
            onBlur={saveTitle}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.target.blur())}
            aria-label="Issue title"
          />

          <div>
            <div className="row between" style={{ marginBottom: 8 }}>
              <div className="section-title" style={{ margin: 0 }}>Description</div>
              {editingDescription && (
                <span className="row" style={{ gap: 6 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setDescription(issue.description); setEditingDescription(false) }}>Cancel</button>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => { saveDescription(); setEditingDescription(false) }}>Save</button>
                </span>
              )}
            </div>
            {editingDescription ? (
              <RichEditor value={description} onChange={setDescription} members={project?.members} minHeight={150} autoFocus placeholder="Describe the work: context, steps to reproduce, acceptance criteria… Paste screenshots straight in." onSubmit={() => { saveDescription(); setEditingDescription(false) }} />
            ) : (
              <div
                className="desc-view"
                role={project?.can_edit ? 'button' : undefined}
                tabIndex={project?.can_edit ? 0 : undefined}
                onClick={(e) => project?.can_edit && e.target.tagName !== 'A' && setEditingDescription(true)}
                onKeyDown={(e) => e.key === 'Enter' && project?.can_edit && setEditingDescription(true)}
              >
                {issue.description.trim() ? <RichText text={issue.description} members={project?.members} className="flush" /> : <span className="muted">{project?.can_edit ? 'Add a description…' : 'No description.'}</span>}
              </div>
            )}
          </div>

          <div>
            <div className="row between" style={{ marginBottom: 8 }}>
              <div className="section-title" style={{ margin: 0 }}>
                Checklist{issue.checklist.length > 0 && ` · ${issue.checklist_done} of ${issue.checklist_total}`}
              </div>
            </div>
            {issue.checklist.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <Progress value={(issue.checklist_done / issue.checklist_total) * 100} color="#22c55e" />
              </div>
            )}
            {issue.checklist.map((item) => (
              <div className="check-row" key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={(e) => checklistCall(`/checklist/${item.id}`, { method: 'PATCH', body: { done: e.target.checked } })}
                  />
                  <span className={item.done ? 'done' : ''}>{item.text}</span>
                </label>
                <button className="btn btn-icon btn-sm btn-ghost" onClick={() => checklistCall(`/checklist/${item.id}`, { method: 'DELETE' })} aria-label={`Remove ${item.text}`}>
                  <X size={13} />
                </button>
              </div>
            ))}
            <form className="row" style={{ marginTop: 6 }} onSubmit={addCheck}>
              <input className="input input-sm" value={checkDraft} maxLength={300} onChange={(e) => setCheckDraft(e.target.value)} placeholder="Add a sub-task and press Enter" />
              <button className="btn btn-sm btn-icon" disabled={!checkDraft.trim()} aria-label="Add sub-task"><Plus size={14} /></button>
            </form>
          </div>

          <div>
            <div className="section-title">Comments · {issue.comments.length}</div>
            <div className="stack" style={{ gap: 12 }}>
              {issue.comments.map((c) => (
                <div className="comment" key={c.id}>
                  <Avatar user={c.author} size={30} />
                  <div className="comment-bubble">
                    <div className="row between">
                      <span>
                        <b>{c.author?.full_name || '⚡ Automation'}</b>{' '}
                        <span className="faint small">{timeAgo(c.created_at)}</span>
                      </span>
                      {(c.author?.id === user.id || project?.can_manage) && (
                        <button className="btn btn-icon btn-sm btn-ghost" style={{ height: 22, width: 22 }} onClick={() => removeComment(c.id)} aria-label="Delete comment">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                    <div className="comment-body"><RichText text={c.body} members={project?.members} className="flush" /></div>
                  </div>
                </div>
              ))}
              <form className="comment-form" onSubmit={postComment}>
                <Avatar user={user} size={30} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <RichEditor compact value={comment} onChange={setComment} members={project?.members} minHeight={56} onSubmit={() => postComment({ preventDefault() {} })} placeholder="Write a comment… Type @ to mention, paste images, ⌘/Ctrl + Enter to send" />
                </div>
                <button className="btn btn-primary btn-icon" disabled={posting || !comment.trim()} aria-label="Send comment">
                  {posting ? <Spinner /> : <Send size={15} />}
                </button>
              </form>
            </div>
          </div>

          {issue.activity.length > 0 && (
            <div>
              <div className="section-title">Activity</div>
              <div className="feed">
                {issue.activity.map((a) => (
                  <div className="feed-item" key={a.id}>
                    <Avatar user={a.user} size={22} />
                    <span className="grow">
                      <span className="who">{a.user?.full_name || 'Someone'}</span>{' '}
                      <span className="muted">{a.message}</span>
                    </span>
                    <span className="faint small">{timeAgo(a.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <aside className="issue-side">
          <Field label="Status">
            <select className="select" value={issue.status} onChange={(e) => patch({ status: e.target.value })}>
              {statusesOf(project || { statuses: [{ key: issue.status, label: issue.status_label, color: issue.status_color }] }).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Assignee">
            <select
              className="select"
              value={issue.assignee?.id || ''}
              onChange={(e) => patch({ assignee_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">Unassigned</option>
              {(project?.members || (issue.assignee ? [issue.assignee] : [])).map((m) => (
                <option key={m.id} value={m.id}>{m.full_name}</option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select className="select" value={issue.priority} onChange={(e) => patch({ priority: e.target.value })}>
              {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select className="select" value={issue.type} onChange={(e) => patch({ type: e.target.value })}>
              {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </Field>
          {features.length > 0 && (
            <Field label="Feature">
              <select
                className="select"
                value={issue.feature_id || ''}
                onChange={(e) => patch({ feature_id: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">None</option>
                {features.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
              </select>
            </Field>
          )}
          {sprints.length > 0 && (
            <Field label="Sprint">
              <select className="select" value={issue.sprint_id || ''} onChange={(e) => patch({ sprint_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Backlog (no sprint)</option>
                {sprints
                  .filter((s) => s.status !== 'completed' || s.id === issue.sprint_id)
                  .map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'active' ? ' (active)' : ''}</option>)}
              </select>
            </Field>
          )}
          <Field label="Milestone">
            <select
              className="select"
              value={issue.milestone_id || ''}
              onChange={(e) => patch({ milestone_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">None</option>
              {milestones
                .filter((m) => m.status === 'open' || m.id === issue.milestone_id)
                .map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Start date">
            <input className="input" type="date" value={issue.start_date || ''} onChange={(e) => patch({ start_date: e.target.value || null })} />
          </Field>
          <Field label="Due date">
            <input className="input" type="date" value={issue.due_date || ''} onChange={(e) => patch({ due_date: e.target.value || null })} />
          </Field>
          <Field label="Blocked by" as="div" hint={issue.blocking.length ? `Blocks ${issue.blocking.map((b) => b.key).join(', ')}` : 'Issues that must finish first'}>
            {issue.blocked_by.length > 0 && (
              <div className="row row-wrap" style={{ gap: 6 }}>
                {issue.blocked_by.map((b) => (
                  <span className="tag" key={b.id} title={b.title} style={b.status === 'done' ? { textDecoration: 'line-through' } : undefined}>
                    {b.key}
                    <button onClick={() => patch({ blocked_by_ids: issue.blocked_by.filter((x) => x.id !== b.id).map((x) => x.id) })} aria-label={`Remove dependency on ${b.key}`}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <select
              className="select input-sm"
              value=""
              onChange={(e) => e.target.value && patch({ blocked_by_ids: [...issue.blocked_by.map((b) => b.id), Number(e.target.value)] })}
              aria-label="Add dependency"
            >
              <option value="">Add dependency…</option>
              {siblings
                .filter((s) => s.id !== issue.id && !issue.blocked_by.some((b) => b.id === s.id))
                .map((s) => <option key={s.id} value={s.id}>{s.key} · {s.title.slice(0, 40)}</option>)}
            </select>
          </Field>
          <Field label="Estimate (h)">
            <input
              className="input"
              type="number"
              min="0"
              step="0.5"
              key={issue.estimate_hours}
              defaultValue={issue.estimate_hours ?? ''}
              onBlur={(e) => {
                const value = e.target.value === '' ? null : Number(e.target.value)
                if (value !== issue.estimate_hours) patch({ estimate_hours: value })
              }}
              placeholder="—"
            />
          </Field>
          {user.org?.modules?.time !== false && user.org?.features?.includes('time_tracking') && <TimeLog issue={issue} canManage={project?.can_manage} onChange={load} />}
          <CustomFields fields={project?.fields} values={issue.custom} onSave={(values) => patch({ custom: values })} />
          <Field label="Repeats" hint={issue.recurrence ? 'The next one is created when this is marked done.' : undefined}>
            <select className="select" value={issue.recurrence} onChange={(e) => patch({ recurrence: e.target.value })}>
              {RECURRENCES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </Field>
          <Field label="Labels" as="div">
            <div className="row row-wrap" style={{ gap: 6 }}>
              {issue.labels.map((l) => (
                <span className="tag" key={l}>
                  {l}
                  <button onClick={() => patch({ labels: issue.labels.filter((x) => x !== l) })} aria-label={`Remove ${l}`}>
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
            <input
              className="input input-sm"
              value={labelDraft}
              maxLength={30}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ',') && (e.preventDefault(), addLabel())}
              onBlur={addLabel}
              placeholder="Add label and press Enter"
            />
          </Field>

          <div className="small faint" style={{ marginTop: 4, lineHeight: 1.7 }}>
            Reported by {issue.reporter?.full_name || 'a deleted user'}
            <br />
            Created {formatDate(issue.created_at, true)} · Updated {timeAgo(issue.updated_at)}
          </div>
          {canDelete && (
            <button className="btn btn-ghost btn-sm danger-text" style={{ alignSelf: 'flex-start' }} onClick={remove}>
              <Trash2 size={14} /> Delete issue
            </button>
          )}
        </aside>
      </div>
      </fieldset>
    </Modal>
  )
}
