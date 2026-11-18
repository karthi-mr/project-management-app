import { AtSign, Bot, Bug, CheckSquare, HelpCircle, Link2, Megaphone, Smile, Users } from 'lucide-react'
import { api } from '../api'
import { Avatar } from '../ui'

/* Chat extras: @mention suggestions, “/” shortcuts, and how mentions and issue keys look in a message. */

export const COMMANDS = [
  { name: 'issue', args: '<key>', hint: 'Share an issue as a link, e.g. /issue APP-12', icon: Link2 },
  { name: 'task', args: '<title>', hint: 'Draft a new task with the assistant', icon: CheckSquare },
  { name: 'bug', args: '<title>', hint: 'Draft a new bug with the assistant', icon: Bug },
  { name: 'ask', args: '<question>', hint: 'Ask the assistant, e.g. /ask overdue', icon: Bot },
  { name: 'me', args: '<action>', hint: 'Say what you are doing: “Dana is reviewing designs”', icon: Megaphone },
  { name: 'shrug', args: '[text]', hint: 'Adds ¯\\_(ツ)_/¯', icon: Smile },
  { name: 'help', args: '', hint: 'Show these shortcuts', icon: HelpCircle },
]

const EVERYONE = new Set(['all', 'everyone', 'here'])

/** Which suggestion list (if any) the text before the caret calls for. */
export function popupFor(draft, caret) {
  const before = draft.slice(0, caret)
  const mention = before.match(/(?:^|\s)@([\w.-]{0,50})$/)
  if (mention) return { kind: 'mention', query: mention[1].toLowerCase(), start: caret - mention[1].length - 1 }
  const slash = before.match(/^\/([a-z]{0,12})$/i)
  if (slash) return { kind: 'slash', query: slash[1].toLowerCase(), start: 0 }
  return null
}

/** People (and, in a group, @all) matching what has been typed after “@”. */
export function mentionOptions(conv, me, query) {
  const people = conv.kind === 'group' ? conv.members.filter((m) => m.id !== me.id) : conv.user ? [conv.user] : []
  const matches = (text) => text.toLowerCase().split(/\s+/).some((w) => w.startsWith(query)) || text.toLowerCase().startsWith(query)
  const options = people
    .filter((p) => !query || matches(p.full_name) || p.username.toLowerCase().startsWith(query))
    .map((p) => ({ key: p.username, label: p.full_name, hint: `@${p.username}`, person: p }))
  if (conv.kind === 'group' && (!query || 'all'.startsWith(query) || 'everyone'.startsWith(query))) {
    options.unshift({ key: 'all', label: 'all', hint: `Notify all ${conv.members.length} members`, everyone: true })
  }
  return options.slice(0, 8)
}

export function commandOptions(query) {
  return COMMANDS.filter((c) => c.name.startsWith(query))
}

/** The suggestion list shown above the message box. */
export function ComposePopup({ popup, options, index, onPick }) {
  if (!popup || options.length === 0) return null
  return (
    <div className="compose-popup" role="listbox" aria-label={popup.kind === 'mention' ? 'People to mention' : 'Shortcuts'}>
      <div className="compose-popup-title">{popup.kind === 'mention' ? 'Mention someone' : 'Shortcuts'}</div>
      {options.map((o, n) => {
        const Icon = o.icon
        return (
          <button
            type="button" key={o.key || o.name} role="option" aria-selected={n === index}
            className={`compose-option ${n === index ? 'active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); onPick(o) }}
          >
            {popup.kind === 'mention'
              ? (o.everyone ? <span className="compose-option-icon"><Users size={15} /></span> : <Avatar user={o.person} size={24} />)
              : <span className="compose-option-icon"><Icon size={15} /></span>}
            <span className="grow">
              <span><b>{popup.kind === 'mention' ? (o.everyone ? '@all' : o.label) : `/${o.name}`}</b>{popup.kind === 'slash' && o.args && <span className="faint"> {o.args}</span>}</span>
              <span className="faint small compose-option-hint">{o.hint}</span>
            </span>
          </button>
        )
      })}
      <div className="compose-popup-foot faint">↑ ↓ to choose · Enter or Tab to insert · Esc to close</div>
    </div>
  )
}

/** Ask the assistant (opens its panel) from anywhere. */
export function askAssistant(text) {
  window.dispatchEvent(new CustomEvent('pm:assistant-ask', { detail: { text } }))
}

/** Turn a typed shortcut into what to do. Returns { body } to send, or { done: true } when handled here. */
export async function runCommand(body, { toast }) {
  const m = body.match(/^\/([a-z]+)\b\s*([\s\S]*)$/i)
  if (!m) return { body }
  const [, name, rest] = m
  const arg = rest.trim()
  switch (name.toLowerCase()) {
    case 'shrug':
      return { body: `${arg} ¯\\_(ツ)_/¯`.trim() }
    case 'me':
      if (!arg) return { error: 'Type what you are doing after /me' }
      return { body: `/me ${arg}` }
    case 'issue': {
      if (!arg) return { error: 'Type an issue key after /issue, for example /issue APP-12' }
      try {
        const issue = await api(`/issues/key/${encodeURIComponent(arg.split(/\s+/)[0])}`)
        return { body: `${issue.key} ${issue.title}` }
      } catch {
        return { error: `No issue ${arg.split(/\s+/)[0].toUpperCase()} that you can open` }
      }
    }
    case 'task':
    case 'bug':
      if (!arg) return { error: `Type a title after /${name}` }
      askAssistant(`create ${name.toLowerCase()} ${arg}`)
      toast('The assistant has drafted it. Check and confirm it there.')
      return { done: true }
    case 'ask':
      if (!arg) return { error: 'Type a question after /ask' }
      askAssistant(arg)
      return { done: true }
    case 'help':
      return { help: true }
    default:
      return { error: `There is no /${name} shortcut. Type / to see them.` }
  }
}

/** A message body with @mentions highlighted and issue keys as links. */
export function MessageText({ text, conv, me, onIssue }) {
  if (!text) return null
  const byUsername = new Map()
  for (const p of conv.kind === 'group' ? conv.members : [conv.user, me]) {
    if (p) byUsername.set(p.username.toLowerCase(), p)
  }
  const parts = []
  const pattern = /(@[\w.-]{2,50})|\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g
  let last = 0
  let match
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[1]) {
      const name = match[1].slice(1).replace(/[._-]+$/, '').toLowerCase()
      const trailing = match[1].slice(1 + name.length)
      const person = byUsername.get(name)
      const everyone = conv.kind === 'group' && EVERYONE.has(name)
      if (person || everyone) {
        parts.push(
          <span key={match.index} className={`mention ${person?.id === me.id || everyone ? 'me' : ''}`} title={person ? `@${person.username}` : 'Everyone in this group'}>
            <AtSign size={11} strokeWidth={2.5} />{person ? person.full_name : name}
          </span>,
        )
        if (trailing) parts.push(trailing)
      } else {
        parts.push(match[1])
      }
    } else {
      const key = match[2]
      parts.push(<button type="button" key={match.index} className="issue-link" onClick={() => onIssue(key)} title={`Open ${key}`}>{key}</button>)
    }
    last = pattern.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}
