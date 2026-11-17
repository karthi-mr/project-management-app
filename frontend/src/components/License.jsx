import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Check, Clock, Lock, Minus, Printer } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../context'
import { Badge, Modal, Spinner, formatDate } from '../ui'

/* Everything a plan can switch on or off. Mirrors FEATURES in backend/app/saas.py. */
export const FEATURE_LABELS = {
  sprints: 'Sprints',
  customization: 'Custom workflows, fields and issue templates',
  automation: 'Automation rules',
  approvals: 'Approvals',
  workload: 'Workload planning',
  budgets: 'Budgets and cost tracking',
  group_chat: 'Group chats',
  audit_log: 'Audit log',
  security: 'Security controls (allowed networks)',
}

export const LICENSE_STATUS = {
  trial: { label: 'Free trial', color: '#6366f1' },
  active: { label: 'Active', color: '#22c55e' },
  expired: { label: 'Expired', color: '#ef4444' },
  suspended: { label: 'Suspended', color: '#94a3b8' },
}

export const REQUEST_STATUS = {
  pending: { label: 'Waiting for activation', color: '#f59e0b' },
  approved: { label: 'Activated', color: '#22c55e' },
  rejected: { label: 'Not approved', color: '#ef4444' },
  cancelled: { label: 'Cancelled', color: '#94a3b8' },
}

export function money(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount)
  } catch {
    return `${currency} ${amount}`
  }
}

export const seatsText = (n) => `${n} ${Number(n) === 1 ? 'user' : 'users'}`

export const LicenseBadge = ({ status }) => {
  const meta = LICENSE_STATUS[status] || LICENSE_STATUS.active
  return <Badge color={meta.color}>{meta.label}</Badge>
}

export const RequestBadge = ({ status }) => {
  const meta = REQUEST_STATUS[status] || REQUEST_STATUS.pending
  return <Badge color={meta.color}>{meta.label}</Badge>
}

/** True unless the workspace has switched this optional module off (Workspace settings). */
export function useModule(key) {
  const { user } = useAuth()
  return user?.org?.modules?.[key] !== false
}

/** True when the workspace's plan includes a capability. */
export function useFeature(feature) {
  const { user } = useAuth()
  return !user?.org || user.org.features.includes(feature)
}

/** Shown in place of something the workspace's plan does not include. */
export function UpgradeNotice({ feature, compact = false }) {
  const { user } = useAuth()
  const isAdmin = user.role === 'admin'
  return (
    <div className={`upgrade ${compact ? 'compact' : ''}`}>
      <span className="upgrade-icon"><Lock size={compact ? 15 : 20} /></span>
      <div className="grow">
        <div style={{ fontWeight: 650 }}>{FEATURE_LABELS[feature]} is not part of your plan</div>
        <div className="muted small">
          {isAdmin
            ? `Your workspace is on ${user.org?.plan?.name || 'a plan'} that does not include it.`
            : 'Ask a workspace administrator to upgrade the plan.'}
        </div>
      </div>
      {isAdmin && <Link className="btn btn-primary btn-sm" to="/billing">See plans</Link>}
    </div>
  )
}

/** Renders its children only when the plan includes the feature. */
export function PlanGate({ feature, children, compact }) {
  return useFeature(feature) ? children : <UpgradeNotice feature={feature} compact={compact} />
}

/** Strip under the top bar: trial countdown, expiry warning, read-only notice. */
export function LicenseBanner() {
  const { user } = useAuth()
  const org = user.org
  if (!org) return null
  const isAdmin = user.role === 'admin'
  const days = org.days_left
  const dayText = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`

  if (org.status === 'suspended') {
    return (
      <div className="license-banner danger">
        <AlertTriangle size={16} />
        <span className="grow">This workspace is suspended, so nothing can be changed. Contact support to restore it.</span>
      </div>
    )
  }
  if (org.status === 'expired') {
    return (
      <div className="license-banner danger">
        <AlertTriangle size={16} />
        <span className="grow">
          {org.is_trial ? 'Your free trial has ended' : 'Your license has expired'}, so the workspace is read-only. Your data is safe.
          {!isAdmin && ' Ask a workspace administrator to renew it.'}
        </span>
        {isAdmin && <Link className="btn btn-sm" to="/billing">{org.is_trial ? 'Choose a plan' : 'Renew'}</Link>}
      </div>
    )
  }
  if (!isAdmin || days == null) return null
  if (org.status === 'trial') {
    return (
      <div className={`license-banner ${days <= 3 ? 'warn' : ''}`}>
        <Clock size={16} />
        <span className="grow">Your free trial ends {dayText}.</span>
        <Link className="btn btn-sm" to="/billing">Choose a plan</Link>
      </div>
    )
  }
  if (days <= 7) {
    return (
      <div className="license-banner warn">
        <Clock size={16} />
        <span className="grow">Your {org.plan?.name} license ends {dayText}. Renew it to keep the workspace editable.</span>
        <Link className="btn btn-sm" to="/billing">Renew</Link>
      </div>
    )
  }
  return null
}

/** What a plan includes, as a tick list. */
export function PlanFeatures({ plan }) {
  return (
    <ul className="plan-features">
      <li><Check size={14} /> {plan.max_users == null ? 'Unlimited users' : `Up to ${plan.max_users} users`}</li>
      <li><Check size={14} /> {plan.max_projects == null ? 'Unlimited projects' : `${plan.max_projects} projects`}</li>
      <li><Check size={14} /> Issues, boards, Gantt, roadmap, documents and chat</li>
      {Object.entries(FEATURE_LABELS).map(([key, label]) => {
        const included = plan.features.includes(key)
        return (
          <li key={key} className={included ? '' : 'off'}>
            {included ? <Check size={14} /> : <Minus size={14} />} {label}
          </li>
        )
      })}
    </ul>
  )
}

/** A printable receipt for an activated license. */
export function InvoiceModal({ invoiceId, onClose }) {
  const [invoice, setInvoice] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api(`/billing/invoices/${invoiceId}`).then(setInvoice).catch((e) => setError(e.message))
  }, [invoiceId])

  const print = () => {
    document.body.classList.add('print-invoice')
    const done = () => {
      document.body.classList.remove('print-invoice')
      window.removeEventListener('afterprint', done)
    }
    window.addEventListener('afterprint', done)
    window.print()
  }

  return (
    <Modal title={invoice ? `Invoice ${invoice.number}` : 'Invoice'} onClose={onClose}>
      <div className="modal-body">
        {error ? <div className="form-error">{error}</div> : !invoice ? <Spinner /> : (
          <div className="invoice">
            <div className="row between row-wrap" style={{ alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{invoice.seller.name}</div>
                {invoice.seller.email && <div className="muted small">{invoice.seller.email}</div>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 700 }}>{invoice.number}</div>
                <div className="muted small">Issued {formatDate(invoice.issued_at, true)}</div>
                <Badge color="#22c55e">Paid</Badge>
              </div>
            </div>
            <div>
              <div className="section-title">Billed to</div>
              <div style={{ fontWeight: 600 }}>{invoice.org_name}</div>
              {invoice.billing_email && <div className="muted small">{invoice.billing_email}</div>}
            </div>
            <table className="table">
              <thead><tr><th>Description</th><th>Users</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                <tr>
                  <td>
                    <b>{invoice.plan_name}</b> license, {invoice.period}
                    <div className="muted small">{formatDate(invoice.period_start, true)} to {formatDate(invoice.period_end, true)}</div>
                  </td>
                  <td>{invoice.seats}</td>
                  <td style={{ textAlign: 'right' }}>{money(invoice.list_amount ?? invoice.amount, invoice.currency)}</td>
                </tr>
                {invoice.list_amount != null && invoice.list_amount !== invoice.amount && (
                  <tr>
                    <td colSpan={2} style={{ textAlign: 'right' }} className="muted">List price {money(invoice.list_amount, invoice.currency)}{invoice.discount_note ? `, ${invoice.discount_note}` : ''}</td>
                    <td style={{ textAlign: 'right' }} className="muted">−{money(invoice.list_amount - invoice.amount, invoice.currency)}</td>
                  </tr>
                )}
                <tr>
                  <td colSpan={2} style={{ textAlign: 'right', fontWeight: 700 }}>Total paid</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(invoice.amount, invoice.currency)}</td>
                </tr>
              </tbody>
            </table>
            <div className="muted small">
              Paid by bank transfer{invoice.payment_reference ? `. Reference: ${invoice.payment_reference}` : ''}.
            </div>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={print} disabled={!invoice}><Printer size={14} /> Print or save as PDF</button>
      </div>
    </Modal>
  )
}
