import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Boxes, FlaskConical, Activity, BarChart3, CalendarDays, ChevronLeft, Columns3, FileText, Flag, GanttChart, Layers, LayoutDashboard, List, Plus, Rocket, Search, Settings, ShieldAlert, Stamp, Users, Zap } from 'lucide-react'
import { api, notifyChanged, onChanged } from '../api'
import { useAuth, useToast } from '../context'
import { useUndoDelete } from '../components/useUndo'
import { AvatarStack, Empty, ProjectStatusBadge, PageSkeleton, ProjectIcon, statusesOf, formatDate, isOverdue } from '../ui'
import IssueForm from '../components/IssueForm'
import { Overview, ProjectTimeline } from './ProjectPlanning'
import { FeatureModal, Features, Releases } from './ProjectFeatures'
import { Documents, Reports, Risks } from './ProjectExtras'
import { Approvals } from '../components/ProjectRules'
import Sprints from './Sprints'
import { PlanGate } from '../components/License'
import { ClientFeedbackCard } from '../components/ProjectSharing'
import Tests from './Tests'
import { EMPTY_FILTERS, applyFilters, FilterBar, Board, IssueTable } from './project/IssueViews'
import { Milestones } from './project/Milestones'
import { Modules } from './project/Modules'
import { Members, ActivityFeed } from './project/Team'
import { ProjectSettings } from './project/ProjectSettings'

const TABS = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'features', label: 'Features', icon: Layers },
  { key: 'modules', label: 'Modules', icon: Boxes },
  { key: 'board', label: 'Board', icon: Columns3 },
  { key: 'list', label: 'List', icon: List },
  { key: 'timeline', label: 'Timeline', icon: GanttChart },
  { key: 'milestones', label: 'Milestones', icon: Flag },
  { key: 'sprints', label: 'Sprints', icon: Zap },
  { key: 'tests', label: 'Tests', icon: FlaskConical },
  { key: 'releases', label: 'Releases', icon: Rocket },
  { key: 'approvals', label: 'Approvals', icon: Stamp },
  { key: 'risks', label: 'Risks', icon: ShieldAlert },
  { key: 'docs', label: 'Docs', icon: FileText },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
  { key: 'members', label: 'Members', icon: Users },
  { key: 'activity', label: 'Activity', icon: Activity },
  { key: 'settings', label: 'Settings', icon: Settings },
]

// Tabs are grouped so a project with every section enabled stays easy to scan.
const TAB_GROUPS = [
  { key: 'plan', label: 'Plan', tabs: ['overview', 'features', 'modules', 'milestones', 'timeline'] },
  { key: 'work', label: 'Work', tabs: ['board', 'list', 'sprints', 'tests', 'docs'] },
  { key: 'deliver', label: 'Deliver', tabs: ['releases', 'approvals', 'risks', 'reports'] },
  { key: 'team', label: 'Team', tabs: ['members', 'activity', 'settings'] },
]

// Which permission each tab needs (tabs not listed are always shown).
const TAB_SECTION = {
  tests: 'features',
  features: 'features', modules: 'features', board: 'issues', list: 'issues', timeline: 'issues', sprints: 'issues', milestones: 'milestones',
  releases: 'releases', risks: 'risks', docs: 'docs', reports: 'reports', activity: 'activity',
}

// Tabs that belong to an optional module the workspace can switch off.
const TAB_MODULE = { sprints: 'sprints', tests: 'tests', docs: 'documents', risks: 'risks' }

function tabsFor(project, modules = {}) {
  if (!project) return TABS
  return TABS.filter((t) => {
    if (TAB_MODULE[t.key] && modules[TAB_MODULE[t.key]] === false) return false
    if (t.key === 'settings') return project.can_manage
    if (t.key === 'reports') return project.sections.includes('reports') && project.sections.includes('issues')
    return !TAB_SECTION[t.key] || project.sections.includes(TAB_SECTION[t.key])
  })
}

/* ───────────── Filters ───────────── */

export default function ProjectDetail() {
  const { user } = useAuth()
  const { projectId } = useParams()
  const [params, setParams] = useSearchParams()
  const toast = useToast()
  const undo = useUndoDelete()
  const [project, setProject] = useState(null)
  const [issues, setIssues] = useState([])
  const [milestones, setMilestones] = useState([])
  const [features, setFeatures] = useState([])
  const [modules, setModules] = useState([])
  const [releases, setReleases] = useState([])
  const [risks, setRisks] = useState([])
  const [checks, setChecks] = useState([])
  const [creatingFeature, setCreatingFeature] = useState(false)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [createStatus, setCreateStatus] = useState(null)

  const tabs = tabsFor(project, user?.org?.modules)
  const tab = tabs.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'overview'
  const groups = TAB_GROUPS.map((g) => ({ ...g, tabs: g.tabs.map((k) => tabs.find((t) => t.key === k)).filter(Boolean) })).filter((g) => g.tabs.length)
  const activeGroup = groups.find((g) => g.tabs.some((t) => t.key === tab)) || groups[0]
  const setTab = (key) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (key === 'overview') next.delete('tab')
      else next.set('tab', key)
      return next
    })

  const featureParam = params.get('feature')
  const setFeatureParam = (id) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (id) next.set('feature', String(id))
      else next.delete('feature')
      return next
    })

  const load = useCallback(async () => {
    try {
      const p = await api(`/projects/${projectId}`)
      // Only ask for the sections this person may see; a refusal never blocks the page.
      const part = (section, path) => (p.sections.includes(section) ? api(path).catch(() => []) : Promise.resolve([]))
      const [i, m, f, r, rk, ck, md] = await Promise.all([
        part('issues', `/issues?project_id=${projectId}&limit=1000`),
        part('milestones', `/projects/${projectId}/milestones`),
        part('features', `/projects/${projectId}/features`),
        part('releases', `/projects/${projectId}/releases`),
        part('risks', `/projects/${projectId}/risks`),
        api(`/projects/${projectId}/phase-checks`).catch(() => []),
        part('features', `/projects/${projectId}/modules`),
      ])
      setProject(p)
      setIssues(i)
      setMilestones(m)
      setFeatures(f)
      setModules(md)
      setReleases(r)
      setRisks(rk)
      setChecks(ck)
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [projectId])

  useEffect(() => {
    setProject(null)
    setFilters(EMPTY_FILTERS)
    load()
    return onChanged(load)
  }, [load])

  const filtered = useMemo(
    () => applyFilters(issues, tab === 'board' ? { ...filters, status: '' } : filters),
    [issues, filters, tab],
  )

  const moveIssue = async (id, status, position) => {
    const previous = issues
    setIssues((list) => list.map((i) => (i.id === id ? { ...i, status, position } : i)))
    try {
      await api(`/issues/${id}`, { method: 'PATCH', body: { status, position } })
      notifyChanged()
    } catch (err) {
      setIssues(previous)
      toast(err.message, 'error')
    }
  }

  if (error && !project) {
    return (
      <div className="page">
        <div className="card">
          <Empty icon={Search} title="Project not found" action={<Link className="btn" to="/projects">Back to projects</Link>}>{error}</Empty>
        </div>
      </div>
    )
  }
  if (!project) return <PageSkeleton variant="project" />
  const highRisks = risks.filter((r) => r.severity === 'high' && r.status !== 'closed').length

  return (
    <div className={`page ${project.can_edit ? '' : 'read-only'}`}>
      <Link to="/projects" className="row small muted" style={{ gap: 4, marginBottom: 10, width: 'fit-content' }}>
        <ChevronLeft size={14} /> Projects
      </Link>
      <div className="page-header">
        <div className="row" style={{ gap: 14, minWidth: 0 }}>
          <ProjectIcon project={project} size={44} />
          <div style={{ minWidth: 0 }}>
            <div className="row row-wrap">
              <h1>{project.name}</h1>
              <ProjectStatusBadge status={project.status} />
            </div>
            <p className="row row-wrap small" style={{ gap: 14 }}>
              <span>{project.open_count} open · {project.done_count} done</span>
              {project.due_date && (
                <span className={`due ${isOverdue(project.due_date, project.status === 'completed') ? 'overdue' : ''}`}>
                  <CalendarDays size={12} /> Due {formatDate(project.due_date, true)}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="row">
          <AvatarStack users={project.members} max={5} size={30} />
        </div>
      </div>

      {!project.can_edit && (
        <div className="callout no-print" style={{ marginBottom: 14 }}>
          <ShieldAlert size={16} />
          <span>You have <b>view-only</b> access to this project. Ask the owner{project.owner ? `, ${project.owner.full_name},` : ''} if you need to make changes.</span>
        </div>
      )}
      <div className="tab-groups" role="tablist" aria-label="Project areas">
        {groups.map((g) => (
          <button
            key={g.key}
            role="tab"
            aria-selected={g.key === activeGroup.key}
            className={`tab-group ${g.key === activeGroup.key ? 'active' : ''}`}
            onClick={() => setTab(g.key === activeGroup.key ? tab : g.tabs[0].key)}
          >
            {g.label}
            {g.tabs.some((t) => t.key === 'risks') && highRisks > 0 && <span className="pill">{highRisks}</span>}
          </button>
        ))}
      </div>
      <div className="tabs" role="tablist" aria-label={`${activeGroup.label} sections`}>
        {activeGroup.tabs.map(({ key, label, icon: Icon }) => (
          <button key={key} role="tab" aria-selected={tab === key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            <Icon size={15} /> {label}
            {key === 'list' && <span className="pill">{issues.length}</span>}
            {key === 'features' && <span className="pill">{features.length}</span>}
            {key === 'risks' && risks.some((r) => r.severity === 'high' && r.status !== 'closed') && (
              <span className="pill alert">{risks.filter((r) => r.severity === 'high' && r.status !== 'closed').length}</span>
            )}
            {key === 'members' && <span className="pill">{project.members.length}</span>}
          </button>
        ))}
      </div>

      {(tab === 'board' || tab === 'list') && (
        <>
          <FilterBar projectId={project.id} statuses={statusesOf(project)} filters={filters} setFilters={setFilters} members={project.members} features={features} showStatus={tab === 'list'} onCreate={project.can_edit ? () => setCreateStatus('todo') : undefined} />
          {issues.length === 0 ? (
            <div className="card">
              <Empty
                icon={Columns3}
                title="No issues yet"
                action={<button className="btn btn-primary" onClick={() => setCreateStatus('todo')}><Plus size={16} /> New issue</button>}
              >
                Create the first issue to start tracking work in {project.name}.
              </Empty>
            </div>
          ) : tab === 'board' ? (
            <Board project={project} issues={issues} filtered={filtered} onMove={moveIssue} onCreate={setCreateStatus} />
          ) : filtered.length === 0 ? (
            <div className="card"><Empty icon={Search} title="No issues match these filters" /></div>
          ) : (
            <IssueTable issues={filtered} bulk={project.can_edit ? { statuses: statusesOf(project), members: project.members, features, milestones: milestones.filter((m) => m.status === 'open') } : undefined} />
          )}
        </>
      )}
      {tab === 'overview' && (
        <Overview project={project} issues={issues} milestones={milestones} modules={modules} features={features} releases={releases} risks={risks} checks={checks} setTab={setTab} reload={load} />
      )}
      {tab === 'features' && (
        <Features project={project} features={features} onOpen={setFeatureParam} onCreate={() => setCreatingFeature(true)} />
      )}
      {tab === 'releases' && <Releases project={project} releases={releases} features={features} />}
      {tab === 'timeline' && (
        <ProjectTimeline project={project} issues={issues} milestones={milestones} modules={modules} features={features} onCreate={() => setCreateStatus('todo')} onOpenFeature={setFeatureParam} />
      )}
      {tab === 'risks' && <Risks project={project} risks={risks} />}
      {tab === 'sprints' && <PlanGate feature="sprints"><Sprints project={project} /></PlanGate>}
      {tab === 'approvals' && <><PlanGate feature="approvals"><Approvals project={project} /></PlanGate>{user?.org?.modules?.client_access !== false && user?.org?.features?.includes('client_portal') && <div style={{ marginTop: 16 }}><ClientFeedbackCard project={project} /></div>}</>}
      {tab === 'tests' && <PlanGate feature="tests"><Tests project={project} features={features} /></PlanGate>}
      {tab === 'docs' && <Documents key={project.id} project={project} />}
      {tab === 'reports' && <Reports project={project} issues={issues} features={features} milestones={milestones} risks={risks} />}
      {tab === 'milestones' && <Milestones project={project} milestones={milestones} reload={load} />}
      {tab === 'modules' && <Modules project={project} features={features} milestones={milestones} onOpenFeature={setFeatureParam} reload={load} />}
      {tab === 'members' && <Members project={project} issues={issues} reload={load} />}
      {tab === 'activity' && <ActivityFeed projectId={project.id} />}
      {tab === 'settings' && <ProjectSettings key={project.id} project={project} issues={issues} reload={load} />}

      {(featureParam || creatingFeature) && (
        <FeatureModal
          key={featureParam || 'new'}
          project={project}
          featureId={creatingFeature ? null : Number(featureParam)}
          releases={releases}
          onClose={() => (creatingFeature ? setCreatingFeature(false) : setFeatureParam(null))}
        />
      )}

      {createStatus && (
        <IssueForm
          projects={[project]}
          defaultProjectId={project.id}
          defaultStatus={createStatus}
          onClose={() => setCreateStatus(null)}
        />
      )}
    </div>
  )
}
