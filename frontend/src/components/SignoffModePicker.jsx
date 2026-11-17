import { SIGNOFF_MODES } from '../ui'

/** Three cards: off, simple, strict. */
export default function SignoffModePicker({ value, onChange, disabled }) {
  return (
    <div className="mode-picker" role="radiogroup" aria-label="Stage sign-off">
      {SIGNOFF_MODES.map((m) => (
        <button
          key={m.key}
          type="button"
          role="radio"
          aria-checked={value === m.key}
          className={`mode-card ${value === m.key ? 'active' : ''}`}
          onClick={() => !disabled && onChange(m.key)}
          disabled={disabled}
        >
          <b>{m.label}{m.key === 'simple' ? ' (recommended)' : ''}</b>
          <span>{m.hint}</span>
        </button>
      ))}
    </div>
  )
}
