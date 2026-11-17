const TOKEN_KEY = 'pm_token'

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable */
  }
}

function errorMessage(detail, status) {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const field = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : ''
        return field && field !== 'body' ? `${field}: ${d.msg}` : d.msg
      })
      .join('; ')
  }
  return `Request failed (${status})`
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new Error('Cannot reach the server. Is the backend running?')
  }

  if (res.status === 204) return null
  let data = null
  try {
    data = await res.json()
  } catch {
    /* non-JSON response */
  }

  if (!res.ok) {
    const detail = data?.detail
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      window.dispatchEvent(new Event('pm:unauthorized'))
    }
    if (res.status === 403 && detail === 'TWO_FACTOR_SETUP_REQUIRED') {
      window.dispatchEvent(new Event('pm:two-factor-required'))
      throw new Error('Set up two-factor sign-in first.')
    }
    if (res.status === 403 && detail === 'PASSWORD_CHANGE_REQUIRED') {
      window.dispatchEvent(new Event('pm:password-required'))
      throw new Error('You must change your password first.')
    }
    // 402: the plan or license does not allow this. Refresh what we know about the workspace.
    if (res.status === 402) window.dispatchEvent(new Event('pm:license'))
    throw new Error(errorMessage(detail, res.status))
  }
  return data
}

// Tiny event bus so any page can refresh after issues change elsewhere.
export function notifyChanged() {
  window.dispatchEvent(new Event('pm:changed'))
}

export function onChanged(handler) {
  window.addEventListener('pm:changed', handler)
  return () => window.removeEventListener('pm:changed', handler)
}

/** Upload one image (File or Blob) and get back its URL. */
export async function uploadImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('Only images can be uploaded')
  if (file.size > 5 * 1024 * 1024) throw new Error('Images can be at most 5 MB')
  let res
  try {
    res = await fetch('/api/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/octet-stream' },
      body: file,
    })
  } catch {
    throw new Error('Cannot reach the server. Is the backend running?')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : `Upload failed (${res.status})`)
  return data.url
}
