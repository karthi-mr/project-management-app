import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings, Trash2 } from 'lucide-react'
import { api, notifyChanged } from '../../api'
import { useAuth, useConfirm, useToast } from '../../context'
import { useUndoDelete } from '../../components/useUndo'
import { Empty, Field, Spinner } from '../../ui'
import { ProjectFormFields } from '../Projects'
import { FieldsCard, LogoCard, WorkflowCard } from '../../components/ProjectSetup'
import { AutomationsCard, IssueTemplatesCard } from '../../components/ProjectRules'
import { PlanGate } from '../../components/License'
import { ClientFeedbackCard, ShareLinksCard, SignoffCard } from '../../components/ProjectSharing'

export function TemplateCard({ project }) {
  const toast = useToast()
  const undo = useUndoDelete()
  const confirm = useConfirm()
  const [templates, setTemplates] = useState([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => api('/templates').then(setTemplates).catch(() => {})
  useEffect(() => {
    load()
  }, [])

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/projects/${project.id}/template`, { method: 'POST', body: { name, description: `Based on ${project.name}` } })
      toast('Template saved. Choose it when creating a new project.')
      setName('')
      load()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (t) => {
    if (!(await confirm({ title: `Delete template “${t.name}”?`, message: 'Projects already created from it are not affected.', confirmLabel: 'Delete', danger: true }))) return
    try {
      await api(`/templates/${t.id}`, { method: 'DELETE' })
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div className="card card-pad stack">
      <div>
        <h2>Project templates</h2>
        <p className="muted small">
          Save this project's structure — features, milestones, phase checklists, documents and risks — to reuse for new projects.
          Issues, people and progress are not copied.
        </p>
      </div>
      <form className="row" onSubmit={save}>
        <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Template name, e.g. Client website" />
        <button className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? <Spinner /> : 'Save as template'}</button>
      </form>
      {templates.length > 0 && (
        <div>
          {templates.map((t) => (
            <div className="row" key={t.id} style={{ padding: '7px 0', borderTop: '1px solid var(--border)' }}>
              <span className="grow truncate">
                <b>{t.name}</b>{t.builtin && <span className="faint small"> · built-in</span>}
                <div className="faint small">
                  {t.summary.features} features · {t.summary.milestones} milestones · {t.summary.documents} documents · {t.summary.risks} risks · {t.summary.phase_checks} checklist items
                </div>
              </span>
              {t.can_delete && (
                <button className="btn btn-ghost btn-sm btn-icon danger-text" onClick={() => remove(t)} aria-label={`Delete template ${t.name}`}><Trash2 size={14} /></button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ProjectSettings({ project, issues, reload }) {
  const { user } = useAuth()
  const mod = user.org?.modules || {}
  const toast = useToast()
  const undo = useUndoDelete()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const [form, setForm] = useState({
    name: project.name,
    description: project.description,
    status: project.status,
    phase: project.phase,
    color: project.color,
    start_date: project.start_date || '',
    due_date: project.due_date || '',
  })
  const [busy, setBusy] = useState(false)

  if (!project.can_manage) {
    return <div className="card"><Empty icon={Settings} title="Restricted">Only the project owner or an administrator can change project settings.</Empty></div>
  }

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/projects/${project.id}`, {
        method: 'PATCH',
        body: { ...form, start_date: form.start_date || null, due_date: form.due_date || null },
      })
      toast('Project saved')
      reload()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${project.name}?`,
      message: `The project and its ${project.issue_count} issue(s) move to the recycle bin. An administrator or the owner can restore it within 30 days.`,
      confirmLabel: 'Delete project',
      danger: true,
    })
    if (!ok) return
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' })
      undo('project', project.id, `Project ${project.name}`)
      notifyChanged()
      navigate('/projects')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div className="settings-section stack">
      <form className="card card-pad stack" onSubmit={save}>
        <h2>Project details</h2>
        <Field label="Name">
          <input className="input" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </Field>
        <ProjectFormFields form={form} setForm={setForm} />
        <div><button className="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? <Spinner /> : 'Save changes'}</button></div>
      </form>
      <LogoCard project={project} reload={reload} />
      <SignoffCard project={project} reload={reload} />
      {mod.client_access !== false && (
        <PlanGate feature="client_portal" compact>
          <ShareLinksCard project={project} />
          <ClientFeedbackCard project={project} />
        </PlanGate>
      )}
      <PlanGate feature="customization" compact>
        <WorkflowCard key={JSON.stringify(project.statuses)} project={project} issues={issues} reload={reload} />
        <FieldsCard project={project} reload={reload} />
        <IssueTemplatesCard project={project} />
      </PlanGate>
      {mod.automation !== false && <PlanGate feature="automation" compact><AutomationsCard project={project} /></PlanGate>}
      <TemplateCard project={project} />
      <div className="card card-pad danger-zone row between row-wrap">
        <div>
          <h3>Delete this project</h3>
          <p className="muted small">All issues, comments, milestones and activity are removed.</p>
        </div>
        <button className="btn btn-danger" onClick={remove}><Trash2 size={15} /> Delete project</button>
      </div>
    </div>
  )
}

/* ───────────── Page ───────────── */
