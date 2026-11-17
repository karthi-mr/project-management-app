import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, Circle, Rocket, X } from 'lucide-react'
import { api, onChanged } from '../api'
import { useAuth } from '../context'
import { Progress } from '../ui'

/** Getting-started checklist for the administrators of a new workspace. */
export default function Onboarding() {
  const { user } = useAuth()
  const [data, setData] = useState(null)
  useEffect(() => {
    if (user.role !== 'admin') return undefined
    const load = () => api('/onboarding').then(setData).catch(() => {})
    load()
    return onChanged(load)
  }, [user.role])
  if (!data?.show) return null

  const dismiss = async () => {
    setData(null)
    await api('/onboarding/dismiss', { method: 'POST' }).catch(() => {})
  }
  const finished = data.done === data.total
  return (
    <div className="card card-pad onboarding">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 className="icon-label"><Rocket size={17} /> <span>{finished ? 'You are all set' : 'Get started'}</span></h2>
          <p className="muted small">{finished ? 'Everything is ready. You can hide this list.' : `${data.done} of ${data.total} done. A few steps to get your team working here.`}</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={dismiss}><X size={14} /> Hide</button>
      </div>
      <Progress value={Math.round((data.done / data.total) * 100)} color="var(--accent)" />
      <div className="onboarding-steps">
        {data.steps.map((step) => (
          <Link key={step.key} to={step.to} className={`onboarding-step ${step.done ? 'done' : ''}`}>
            {step.done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
            <span><b>{step.title}</b><span className="small muted">{step.hint}</span></span>
          </Link>
        ))}
      </div>
    </div>
  )
}
