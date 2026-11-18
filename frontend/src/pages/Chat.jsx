import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowLeft, CheckCheck, ImagePlus, LogOut, MessagesSquare, Pencil, Reply, Search, Send, Smile, Trash2, UserMinus, UserPlus, Users, X } from 'lucide-react'
import { api, uploadImage } from '../api'
import { useAuth, useToast } from '../context'
import { isRealtimeConnected, onRealtime, onlineUsers, sendRealtime } from '../realtime'
import { Avatar, AvatarStack, Field, Modal, Spinner, timeAgo, useOpenIssue } from '../ui'
import { ComposePopup, MessageText, commandOptions, mentionOptions, popupFor, runCommand } from '../components/ChatExtras'
import { useConfirm } from '../context'
import { useFeature } from '../components/License'
import { localeTag, withZone } from '../i18n'

const REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '✅']
const EMOJI = ['😀', '😂', '😊', '😍', '🤔', '😅', '😢', '😎', '👍', '👎', '👏', '🙏', '🙌', '💪', '🎉', '🔥', '❤️', '✅', '❌', '⭐', '🚀', '👀', '💡', '☕']
// With the live connection open these timers are only a safety net.
const LIST_POLL_MS = 30000
const THREAD_POLL_MS = 20000

const dayKey = (iso) => new Date(iso).toDateString()

function dayLabel(iso) {
  const date = new Date(iso)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

const clock = (iso) => new Date(iso).toLocaleTimeString(localeTag(), withZone({ hour: 'numeric', minute: '2-digit' }))

/** Avatar with a green dot when the person is connected right now. */
function PresenceAvatar({ person, size, online }) {
  return (
    <span className={`presence ${online ? 'online' : ''}`} title={online ? 'Online' : 'Offline'}>
      <Avatar user={person} size={size} />
    </span>
  )
}

function ConversationAvatar({ conv, size, online }) {
  if (conv.kind === 'group') {
    return (
      <span className="chat-avatar group" style={{ width: size, height: size }} title={`${conv.members.length} members`}>
        <Users size={size * 0.46} />
      </span>
    )
  }
  return <PresenceAvatar person={conv.user} size={size} online={online.has(conv.user?.id)} />
}

function PeoplePicker({ people, chosen, setChosen }) {
  const [query, setQuery] = useState('')
  const term = query.trim().toLowerCase()
  const shown = people.filter((p) => !term || `${p.full_name} ${p.username}`.toLowerCase().includes(term))
  const toggle = (id) => setChosen((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))
  return (
    <>
      <div className="input-icon"><Search size={15} /><input className="input" placeholder="Search people…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <div className="check-list" style={{ maxHeight: 260 }}>
        {shown.length === 0 && <span className="muted small" style={{ padding: 8 }}>No one to add.</span>}
        {shown.map((p) => (
          <label className="check-item" key={p.id}>
            <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} />
            <Avatar user={p} size={24} />
            <span className="grow">{p.full_name}</span>
            <span className="faint small">@{p.username}</span>
          </label>
        ))}
      </div>
    </>
  )
}

function NewGroupModal({ people, onClose, onCreated }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [chosen, setChosen] = useState([])
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      onCreated(await api('/chat/groups', { method: 'POST', body: { name, member_ids: chosen } }))
      onClose()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }
  return (
    <Modal title="New group" onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <div className="modal-body">
          <Field label="Group name"><input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Launch team" autoFocus required /></Field>
          <Field label={`Members${chosen.length ? ` · ${chosen.length} chosen` : ''}`} as="div"><PeoplePicker people={people} chosen={chosen} setChosen={setChosen} /></Field>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !name.trim() || !chosen.length}>{busy ? <Spinner /> : 'Create group'}</button>
        </div>
      </form>
    </Modal>
  )
}

function GroupInfoModal({ conv, people, online, onClose, onChanged }) {
  const { user } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [name, setName] = useState(conv.title)
  const [adding, setAdding] = useState([])
  const isCreator = conv.created_by_id === user.id || user.role === 'admin'
  const memberIds = new Set(conv.members.map((m) => m.id))

  const call = async (fn, message) => {
    try {
      const result = await fn()
      if (message) toast(message)
      onChanged(result)
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const leave = async () => {
    if (!(await confirm({ title: `Leave “${conv.title}”?`, message: 'You will stop receiving its messages. Someone in the group can add you back.', confirmLabel: 'Leave group', danger: true }))) return
    call(() => api(`/chat/groups/${conv.id}/members/${user.id}`, { method: 'DELETE' }), 'You left the group')
    onClose()
  }

  return (
    <Modal title="Group details" onClose={onClose} size="sm">
      <div className="modal-body">
        <form className="row" onSubmit={(e) => { e.preventDefault(); call(() => api(`/chat/groups/${conv.id}`, { method: 'PATCH', body: { name } }), 'Group renamed') }}>
          <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Group name" />
          <button className="btn" disabled={!name.trim() || name === conv.title}><Pencil size={14} /> Rename</button>
        </form>
        <div>
          <div className="section-title">{conv.members.length} members</div>
          {conv.members.map((m) => (
            <div className="time-row" key={m.id}>
              <PresenceAvatar person={m} size={26} online={online.has(m.id)} />
              <span className="grow">{m.full_name}{m.id === user.id && <span className="faint"> (you)</span>}{m.id === conv.created_by_id && <span className="faint"> · created the group</span>}</span>
              {isCreator && m.id !== user.id && (
                <button className="btn btn-ghost btn-sm btn-icon danger-text" style={{ opacity: 1 }} onClick={() => call(() => api(`/chat/groups/${conv.id}/members/${m.id}`, { method: 'DELETE' }), `${m.full_name} removed`)} aria-label={`Remove ${m.full_name}`}><UserMinus size={14} /></button>
              )}
            </div>
          ))}
        </div>
        <Field label="Add people" as="div">
          <PeoplePicker people={people.filter((p) => !memberIds.has(p.id))} chosen={adding} setChosen={setAdding} />
          <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} disabled={!adding.length} onClick={() => { call(() => api(`/chat/groups/${conv.id}/members`, { method: 'POST', body: { user_ids: adding } }), 'Members added'); setAdding([]) }}>
            <UserPlus size={14} /> Add {adding.length || ''}
          </button>
        </Field>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost danger-text" style={{ marginRight: 'auto' }} onClick={leave}><LogOut size={14} /> Leave group</button>
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  )
}

function useOnline() {
  const [online, setOnline] = useState(() => new Set(onlineUsers()))
  useEffect(() => {
    api('/chat/online').then((r) => setOnline(new Set(r.online))).catch(() => {})
    return onRealtime('presence', (set) => setOnline(new Set(set)))
  }, [])
  return online
}

function Thread({ conv, online, people, onBack, onActivity, onGroupChanged }) {
  const { user } = useAuth()
  const toast = useToast()
  const [messages, setMessages] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [otherRead, setOtherRead] = useState(conv.other_last_read_id || 0)
  const [reads, setReads] = useState({}) // group chats: { userId: lastReadId }
  const [typingName, setTypingName] = useState('')
  const [showInfo, setShowInfo] = useState(false)
  const isGroup = conv.kind === 'group'
  const nameOf = (id) => (conv.members || []).find((m) => m.id === id)?.full_name?.split(' ')[0] || conv.title.split(' ')[0]
  const [draft, setDraft] = useState('')
  // “@” suggestions and “/” shortcuts above the message box.
  const [popup, setPopup] = useState(null)
  const [popupIndex, setPopupIndex] = useState(0)
  const popupOptions = popup ? (popup.kind === 'mention' ? mentionOptions(conv, user, popup.query) : commandOptions(popup.query)) : []
  const openIssue = useOpenIssue()
  const openIssueKey = (key) => api(`/issues/key/${key}`).then((i) => openIssue(i.id)).catch(() => toast(`You cannot open ${key}`, 'error'))
  const [replyTo, setReplyTo] = useState(null)
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [picker, setPicker] = useState(null) // message id whose reaction picker is open
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [typing, setTyping] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  const fileRef = useRef(null)
  const stickToBottom = useRef(true)
  const lastId = useRef(0)
  const lastTypingSent = useRef(0)
  const typingTimer = useRef(null)

  const merge = useCallback((incoming) => {
    setMessages((list) => {
      const map = new Map((list || []).map((m) => [m.id, m]))
      incoming.forEach((m) => map.set(m.id, m))
      return [...map.values()].sort((a, b) => a.id - b.id)
    })
    const newest = Math.max(lastId.current, ...incoming.map((m) => m.id))
    lastId.current = newest
  }, [])

  const fetchNew = useCallback(() => {
    api(`/chat/conversations/${conv.id}/messages?after=${lastId.current}`)
      .then((data) => {
        setOtherRead(data.other_last_read_id)
        if (data.reads) setReads((r) => ({ ...r, ...data.reads }))
        if (data.messages.length) {
          merge(data.messages)
          onActivity()
        }
      })
      .catch(() => {})
  }, [conv.id, merge, onActivity])

  useEffect(() => {
    let cancelled = false
    setMessages(null)
    setReplyTo(null)
    lastId.current = 0
    stickToBottom.current = true
    api(`/chat/conversations/${conv.id}/messages`)
      .then((data) => {
        if (cancelled) return
        setMessages(data.messages)
        setHasMore(data.has_more)
        setOtherRead(data.other_last_read_id)
        setReads(data.reads || {})
        lastId.current = data.messages.at(-1)?.id || 0
        onActivity()
      })
      .catch((err) => !cancelled && toast(err.message, 'error'))

    const offs = [
      onRealtime('chat.message', (event) => {
        if (event.message.conversation_id !== conv.id) return
        setTyping(false)
        // Someone else's message while this conversation is on screen: fetch it, which marks it
        // read on the server (and sends them a read receipt). Otherwise just show it.
        if (event.message.sender?.id !== user.id && document.visibilityState === 'visible') fetchNew()
        else merge([event.message])
      }),
      onRealtime('chat.updated', (event) => event.message.conversation_id === conv.id && merge([event.message])),
      onRealtime('chat.deleted', (event) => {
        if (event.conversation_id === conv.id) setMessages((list) => (list || []).filter((m) => m.id !== event.message_id))
      }),
      onRealtime('chat.read', (event) => {
        if (event.conversation_id !== conv.id) return
        setOtherRead(event.last_read_id)
        if (event.user_id) setReads((r) => ({ ...r, [event.user_id]: event.last_read_id }))
      }),
      onRealtime('chat.typing', (event) => {
        if (event.conversation_id !== conv.id) return
        setTyping(true)
        setTypingName(nameOf(event.user_id))
        clearTimeout(typingTimer.current)
        typingTimer.current = setTimeout(() => setTyping(false), 3500)
      }),
      onRealtime('status', (connected) => connected && fetchNew()), // catch up after a reconnect
    ]
    const timer = setInterval(() => document.visibilityState === 'visible' && fetchNew(), isRealtimeConnected() ? THREAD_POLL_MS : 4000)
    const onVisible = () => document.visibilityState === 'visible' && fetchNew()
    document.addEventListener('visibilitychange', onVisible)
    inputRef.current?.focus()
    return () => {
      cancelled = true
      offs.forEach((off) => off())
      clearInterval(timer)
      clearTimeout(typingTimer.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [conv.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, typing])

  const onScroll = () => {
    const el = scrollRef.current
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const loadOlder = async () => {
    const el = scrollRef.current
    const previousHeight = el.scrollHeight
    try {
      const data = await api(`/chat/conversations/${conv.id}/messages?before=${messages[0].id}`)
      stickToBottom.current = false
      setMessages((list) => [...data.messages, ...list])
      setHasMore(data.has_more)
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - previousHeight
      })
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const post = async (payload) => {
    setSending(true)
    try {
      const message = await api(`/chat/conversations/${conv.id}/messages`, { method: 'POST', body: { ...payload, reply_to_id: replyTo?.id ?? null } })
      stickToBottom.current = true
      merge([message])
      setReplyTo(null)
      onActivity()
      return true
    } catch (err) {
      toast(err.message, 'error')
      return false
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  const clearDraft = () => {
    setDraft('')
    setPopup(null)
    if (inputRef.current) inputRef.current.style.height = 'auto'
  }

  const send = async () => {
    let body = draft.trim()
    if (!body || sending) return
    if (body.startsWith('/')) {
      const result = await runCommand(body, { toast })
      if (result.error) return toast(result.error, 'error')
      if (result.help) {
        setDraft('/')
        setPopup({ kind: 'slash', query: '', start: 0 })
        setPopupIndex(0)
        return
      }
      if (result.done) return clearDraft()
      body = result.body
    }
    if (await post({ body })) clearDraft()
  }

  const refreshPopup = (value, caret) => {
    const next = popupFor(value, caret)
    setPopup(next)
    if (!next || next.kind !== popup?.kind || next.query !== popup?.query) setPopupIndex(0)
  }

  const pick = (option) => {
    const el = inputRef.current
    const caret = el?.selectionStart ?? draft.length
    let value
    let at
    if (popup.kind === 'mention') {
      const insert = `@${option.key} `
      value = draft.slice(0, popup.start) + insert + draft.slice(caret)
      at = popup.start + insert.length
    } else {
      const insert = `/${option.name} `
      value = insert + draft.replace(/^\/\S*\s?/, '')
      at = insert.length
      if (option.name === 'help') value = '/'
    }
    setDraft(value)
    setPopup(option.name === 'help' ? { kind: 'slash', query: '', start: 0 } : null)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(value === '/' ? 1 : at, value === '/' ? 1 : at)
    })
  }

  const sendImages = async (files) => {
    const images = [...files].filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    setUploading(true)
    try {
      for (const file of images) {
        const url = await uploadImage(file)
        await post({ body: '', image_url: url })
      }
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setUploading(false)
    }
  }

  const react = async (message, emoji) => {
    setPicker(null)
    try {
      merge([await api(`/chat/messages/${message.id}/reactions`, { method: 'POST', body: { emoji } })])
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const remove = async (message) => {
    try {
      await api(`/chat/messages/${message.id}`, { method: 'DELETE' })
      setMessages((list) => list.filter((m) => m.id !== message.id))
      onActivity()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const onDraft = (e) => {
    setDraft(e.target.value)
    refreshPopup(e.target.value, e.target.selectionStart)
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
    if (e.target.value && Date.now() - lastTypingSent.current > 2000) {
      lastTypingSent.current = Date.now()
      sendRealtime({ type: 'typing', conversation_id: conv.id })
    }
  }

  const addEmoji = (emoji) => {
    const el = inputRef.current
    const at = el?.selectionStart ?? draft.length
    setDraft(draft.slice(0, at) + emoji + draft.slice(at))
    setEmojiOpen(false)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + emoji.length, at + emoji.length)
    })
  }

  const isOnline = isGroup ? false : online.has(conv.user?.id)
  const onlineCount = isGroup ? conv.members.filter((m) => m.id !== user.id && online.has(m.id)).length : 0
  const lastMine = messages ? [...messages].reverse().find((m) => m.sender?.id === user.id) : null
  const firstName = conv.title.split(' ')[0]

  return (
    <section className="chat-main">
      <header className="chat-head">
        <button className="btn btn-icon btn-ghost chat-back" onClick={onBack} aria-label="Back to conversations"><ArrowLeft size={18} /></button>
        <ConversationAvatar conv={conv} size={36} online={online} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="truncate" style={{ fontWeight: 650, fontSize: 15 }}>{conv.title}</div>
          <div className="small faint truncate">
            {typing ? `${isGroup ? `${typingName} is ` : ''}typing…` : isGroup ? `${conv.members.length} members${onlineCount ? ` · ${onlineCount} online` : ''}` : isOnline ? 'Online' : `@${conv.user?.username || 'deleted'}`}
          </div>
        </div>
        {isGroup && (
          <>
            <span className="hide-mobile"><AvatarStack users={conv.members} max={4} size={26} /></span>
            <button className="btn btn-sm" onClick={() => setShowInfo(true)}><Users size={14} /> Members</button>
          </>
        )}
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} onClick={() => setPicker(null)}>
        {!messages ? <Spinner page /> : messages.length === 0 ? (
          <div className="empty" style={{ margin: 'auto' }}>
            <Avatar user={conv.user} size={56} />
            <h3 style={{ marginTop: 6 }}>{isGroup ? `Welcome to ${conv.title}` : `Say hello to ${firstName}`}</h3>
            <p>{isGroup ? 'Only the members of this group can see its messages.' : 'This is the start of your conversation. Only the two of you can see it.'}</p>
          </div>
        ) : (
          <>
            {hasMore && <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'center' }} onClick={loadOlder}>Load earlier messages</button>}
            {messages.map((m, n) => {
              const previous = messages[n - 1]
              const next = messages[n + 1]
              const mine = m.sender?.id === user.id
              const newDay = !previous || dayKey(previous.created_at) !== dayKey(m.created_at)
              const sameAsPrevious = !newDay && previous?.sender?.id === m.sender?.id && new Date(m.created_at) - new Date(previous.created_at) < 5 * 60000
              const lastOfRun = !next || next.sender?.id !== m.sender?.id || dayKey(next.created_at) !== dayKey(m.created_at) || new Date(next.created_at) - new Date(m.created_at) >= 5 * 60000
              if (!m.sender) {
                return (
                  <div key={m.id} style={{ display: 'contents' }}>
                    {newDay && <div className="chat-day">{dayLabel(m.created_at)}</div>}
                    <div className="chat-system">{m.body} · {clock(m.created_at)}</div>
                  </div>
                )
              }
              return (
                <div key={m.id} style={{ display: 'contents' }}>
                  {newDay && <div className="chat-day">{dayLabel(m.created_at)}</div>}
                  <div className={`msg ${mine ? 'mine' : ''} ${sameAsPrevious ? '' : 'first'}`}>
                    {!mine && <span className="avatar-slot">{lastOfRun && <Avatar user={m.sender} size={28} />}</span>}
                    <div className="msg-col">
                      {isGroup && !mine && !sameAsPrevious && <span className="msg-name">{m.sender?.full_name}</span>}
                      <div className={`bubble ${m.image_url ? 'has-image' : ''} ${!mine && (m.mentions?.includes(user.id) || (isGroup && m.mentions_all)) ? 'mentions-me' : ''}`} title={new Date(m.created_at).toLocaleString(localeTag(), withZone())}>
                        {m.reply_to && (
                          <span className="quote" style={m.image_url ? { margin: '2px 2px 6px' } : undefined}>
                            <b>{m.reply_to.sender_name}</b>{m.reply_to.body}
                          </span>
                        )}
                        {m.image_url && <img className="shared" src={m.image_url} alt="Shared" loading="lazy" onClick={() => setLightbox(m.image_url)} />}
                        {m.body && (() => {
                          // “/me is reviewing designs” reads as “Dana is reviewing designs”.
                          const content = m.body.startsWith('/me ')
                            ? <i className="msg-action">{m.sender?.full_name?.split(' ')[0] || 'Someone'} <MessageText text={m.body.slice(4)} conv={conv} me={user} onIssue={openIssueKey} /></i>
                            : <MessageText text={m.body} conv={conv} me={user} onIssue={openIssueKey} />
                          return m.image_url ? <span className="bubble-text">{content}</span> : content
                        })()}
                      </div>
                      {m.reactions.length > 0 && (
                        <div className="reactions">
                          {m.reactions.map((r) => (
                            <button key={r.emoji} className={`reaction ${r.mine ? 'mine' : ''}`} onClick={() => react(m, r.emoji)} title={r.mine ? 'Remove your reaction' : 'Add this reaction'}>
                              {r.emoji} {r.count}
                            </button>
                          ))}
                        </div>
                      )}
                      {lastOfRun && <span className="msg-time">{clock(m.created_at)}</span>}
                      {mine && lastMine?.id === m.id && !isGroup && otherRead >= m.id && <span className="msg-seen"><CheckCheck size={11} style={{ verticalAlign: -1 }} /> Seen</span>}
                      {mine && lastMine?.id === m.id && isGroup && (() => {
                        const seen = Object.entries(reads).filter(([, last]) => last >= m.id).map(([id]) => nameOf(Number(id)))
                        return seen.length > 0 && <span className="msg-seen" title={seen.join(', ')}><CheckCheck size={11} style={{ verticalAlign: -1 }} /> Seen by {seen.length === conv.members.length - 1 ? 'everyone' : seen.join(', ')}</span>
                      })()}
                    </div>
                    <div className={`msg-actions ${picker === m.id ? 'open' : ''}`} style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => setPicker(picker === m.id ? null : m.id)} aria-label="React" title="React"><Smile size={14} /></button>
                      <button onClick={() => { setReplyTo(m); inputRef.current?.focus() }} aria-label="Reply" title="Reply"><Reply size={14} /></button>
                      {mine && <button className="danger" onClick={() => remove(m)} aria-label="Delete message" title="Delete"><Trash2 size={14} /></button>}
                      {picker === m.id && (
                        <div className="emoji-pop" style={mine ? { right: 0 } : { left: 0 }}>
                          {REACTIONS.map((emoji) => <button key={emoji} onClick={() => react(m, emoji)} aria-label={`React ${emoji}`}>{emoji}</button>)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>

      <div className="typing" aria-live="polite">
        {typing && <><span className="typing-dots"><i /><i /><i /></span> {isGroup ? typingName : firstName} is typing</>}
      </div>

      {replyTo && (
        <div className="reply-bar">
          <Reply size={14} />
          <span className="grow truncate"><b>Replying to {replyTo.sender?.id === user.id ? 'yourself' : replyTo.sender?.full_name || 'message'}</b> · {replyTo.body || 'Photo'}</span>
          <button className="btn btn-icon btn-sm btn-ghost" onClick={() => setReplyTo(null)} aria-label="Cancel reply"><X size={14} /></button>
        </div>
      )}

      {conv.active ? (
        <div className="chat-compose compose-wrap">
          <div className="compose-tools">
            <button className="btn btn-icon btn-ghost" onClick={() => fileRef.current?.click()} disabled={uploading} aria-label="Send an image" title="Send an image">
              {uploading ? <Spinner /> : <ImagePlus size={18} />}
            </button>
            <button className="btn btn-icon btn-ghost" onClick={() => setEmojiOpen((v) => !v)} aria-label="Insert emoji" title="Emoji" aria-expanded={emojiOpen}><Smile size={18} /></button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { sendImages(e.target.files); e.target.value = '' }} />
          </div>
          <ComposePopup popup={popup} options={popupOptions} index={Math.min(popupIndex, Math.max(0, popupOptions.length - 1))} onPick={pick} />
          {emojiOpen && (
            <div className="emoji-pop" style={{ left: 20, bottom: 'calc(100% - 4px)', flexWrap: 'wrap', width: 300, borderRadius: 16 }}>
              {EMOJI.map((emoji) => <button key={emoji} onClick={() => addEmoji(emoji)} aria-label={`Insert ${emoji}`}>{emoji}</button>)}
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            maxLength={4000}
            placeholder={`Message ${isGroup ? conv.title : firstName} · @ to mention, / for shortcuts`}
            onChange={onDraft}
            onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) refreshPopup(draft, e.target.selectionStart) }}
            onClick={(e) => refreshPopup(draft, e.target.selectionStart)}
            onBlur={() => setTimeout(() => setPopup(null), 150)}
            onKeyDown={(e) => {
              if (popup && popupOptions.length > 0) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const step = e.key === 'ArrowDown' ? 1 : -1
                  setPopupIndex((i) => (i + step + popupOptions.length) % popupOptions.length)
                  return
                }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  // A complete shortcut with its text typed is sent as it is.
                  if (!(popup.kind === 'slash' && e.key === 'Enter' && /^\/\w+\s+\S/.test(draft))) {
                    e.preventDefault()
                    pick(popupOptions[Math.min(popupIndex, popupOptions.length - 1)])
                    return
                  }
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setPopup(null)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              } else if (e.key === 'Escape') {
                setEmojiOpen(false)
                setReplyTo(null)
              }
            }}
            onPaste={(e) => {
              const files = [...(e.clipboardData?.files || [])]
              if (files.some((f) => f.type.startsWith('image/'))) {
                e.preventDefault()
                sendImages(files)
              }
            }}
            aria-label="Message"
          />
          <button className="btn btn-primary chat-send" onClick={send} disabled={!draft.trim() || sending} aria-label="Send message">
            {sending ? <Spinner /> : <Send size={17} />}
          </button>
        </div>
      ) : (
        <div className="chat-compose"><span className="muted small" style={{ padding: '12px 4px' }}>This account is no longer active, so new messages cannot be sent.</span></div>
      )}

      {showInfo && <GroupInfoModal conv={conv} people={people} online={online} onClose={() => setShowInfo(false)} onChanged={onGroupChanged} />}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label="Image preview">
          <img src={lightbox} alt="Shared" />
        </div>
      )}
    </section>
  )
}

export default function Chat() {
  const { user } = useAuth()
  const toast = useToast()
  const online = useOnline()
  const [params, setParams] = useSearchParams()
  const [conversations, setConversations] = useState(null)
  const [people, setPeople] = useState([])
  const [query, setQuery] = useState('')
  const [creatingGroup, setCreatingGroup] = useState(false)
  const canGroup = useFeature('group_chat')
  const [live, setLive] = useState(isRealtimeConnected())
  const activeId = Number(params.get('c')) || null

  const load = useCallback(() => {
    api('/chat/conversations')
      .then(setConversations)
      .catch((err) => setConversations((current) => current || (toast(err.message, 'error'), [])))
  }, [toast])

  useEffect(() => {
    load()
    const loadPeople = () =>
      api('/users')
        .then((rows) => setPeople(rows.filter((u) => u.id !== user.id && u.is_active !== false)))
        .catch(() => {})
    loadPeople()
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), LIST_POLL_MS)
    const peopleTimer = setInterval(() => document.visibilityState === 'visible' && loadPeople(), 60000)
    const offs = [
      onRealtime('chat.message', load),
      onRealtime('chat.deleted', load),
      onRealtime('chat.group', load),
      onRealtime('status', (connected) => {
        setLive(connected)
        if (connected) load()
      }),
    ]
    return () => {
      clearInterval(timer)
      clearInterval(peopleTimer)
      offs.forEach((off) => off())
    }
  }, [load, user.id])

  const refresh = useCallback(() => {
    load()
    window.dispatchEvent(new Event('pm:chat-read'))
  }, [load])

  const open = (id) => setParams(id ? { c: String(id) } : {})

  const startDirect = async (person) => {
    try {
      const conv = await api('/chat/direct', { method: 'POST', body: { user_id: person.id } })
      setConversations((list) => ((list || []).some((c) => c.id === conv.id) ? list : [conv, ...(list || [])]))
      open(conv.id)
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const active = conversations?.find((c) => c.id === activeId) || null
  const term = query.trim().toLowerCase()
  const { recent, others } = useMemo(() => {
    // A conversation appears once it has messages (or while it is open); everyone else is listed below.
    const started = (conversations || []).filter((c) => c.last_message || c.id === activeId)
    const talkingTo = new Set(started.filter((c) => c.kind === 'direct').map((c) => c.user?.id))
    const matches = (text) => !term || text.toLowerCase().includes(term)
    return {
      recent: started.filter((c) => matches(`${c.title} ${c.user?.username || ''} ${(c.members || []).map((m) => m.full_name).join(' ')}`)),
      others: people
        .filter((p) => !talkingTo.has(p.id) && matches(`${p.full_name} ${p.username}`))
        .sort((a, b) => online.has(b.id) - online.has(a.id) || a.full_name.localeCompare(b.full_name)),
    }
  }, [conversations, people, term, activeId, online])

  return (
    <div className={`chat ${active ? 'open' : ''}`}>
      <aside className="chat-side">
        <div className="chat-side-head">
          <h1 style={{ fontSize: 20 }}>Chat</h1>
          <span className="row" style={{ gap: 8 }}>
          <button className="btn btn-sm" onClick={() => (canGroup ? setCreatingGroup(true) : toast('Group chats are not part of your plan. An administrator can upgrade on the Billing page.', 'info'))} title="Start a group chat"><Users size={14} /> New group</button>
          <span className={`live-dot ${live ? 'on' : ''}`} title={live ? 'Messages arrive instantly' : 'Reconnecting — messages refresh every few seconds'}>
            <i /> {live ? 'Live' : 'Reconnecting'}
          </span>
          </span>
        </div>
        <div className="chat-search">
          <div className="input-icon">
            <Search size={15} />
            <input className="input input-sm" placeholder="Search people…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search people" />
          </div>
        </div>
        <div className="chat-list">
          {!conversations ? <Spinner page /> : (
            <>
              {recent.length > 0 && <div className="chat-group">Conversations</div>}
              {recent.map((c) => (
                <button key={c.id} className={`chat-row ${c.id === activeId ? 'active' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => open(c.id)}>
                  <ConversationAvatar conv={c} size={38} online={online} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <div className="row between" style={{ gap: 8 }}>
                      <span className="name truncate">{c.title}</span>
                      {c.last_message && <span className="when">{timeAgo(c.last_message.created_at)}</span>}
                    </div>
                    <div className="row between" style={{ gap: 8 }}>
                      <span className="preview truncate">
                        {c.last_message ? `${c.last_message.action ? '' : c.last_message.sender_name === 'You' ? 'You: ' : c.kind === 'group' && c.last_message.sender_name !== 'Someone' ? `${c.last_message.sender_name}: ` : ''}${c.last_message.body}` : 'No messages yet'}
                      </span>
                      {c.mentions > 0 && c.id !== activeId && <span className="chat-badge mention-badge" title={`${c.mentions} unread ${c.mentions === 1 ? 'mention' : 'mentions'}`}>@</span>}
                      {c.unread > 0 && c.id !== activeId && <span className="chat-badge">{c.unread > 99 ? '99+' : c.unread}</span>}
                    </div>
                  </span>
                </button>
              ))}
              {others.length > 0 && <div className="chat-group">{recent.length ? 'Other people' : 'People'}</div>}
              {others.map((p) => (
                <button key={p.id} className="chat-row" onClick={() => startDirect(p)}>
                  <PresenceAvatar person={p} size={38} online={online.has(p.id)} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <div className="name truncate">{p.full_name}</div>
                    <div className="preview truncate">@{p.username} · {online.has(p.id) ? 'online' : 'start a conversation'}</div>
                  </span>
                </button>
              ))}
              {recent.length === 0 && others.length === 0 && (
                <p className="muted small" style={{ padding: 12 }}>
                  {term ? 'No one matches that search.' : 'There are no other users yet. An administrator can add them.'}
                </p>
              )}
            </>
          )}
        </div>
      </aside>
      {creatingGroup && (
        <NewGroupModal
          people={people}
          onClose={() => setCreatingGroup(false)}
          onCreated={(conv) => {
            setConversations((list) => [conv, ...(list || [])])
            open(conv.id)
          }}
        />
      )}

      {active ? (
        <Thread
          key={active.id}
          conv={active}
          online={online}
          people={people}
          onBack={() => open(null)}
          onActivity={refresh}
          onGroupChanged={(result) => {
            if (result?.left) open(null)
            load()
          }}
        />
      ) : (
        <section className="chat-main">
          <div className="chat-empty">
            <div className="empty">
              <div className="empty-icon"><MessagesSquare size={24} /></div>
              <h3>{activeId && conversations ? 'Conversation not found' : 'Pick someone to chat with'}</h3>
              <p>Choose a person on the left for a private message, or start a group with “New group”.</p>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
