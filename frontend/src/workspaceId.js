/* The workspace ID people type when they sign in, remembered on this device after the first
 * sign-in so they normally only type it once. */
const KEY = 'pm_workspace'

export function rememberedWorkspace() {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) || 'null')
    return value && value.id ? value : null
  } catch {
    return null
  }
}

export function rememberWorkspace(org) {
  if (!org?.public_id) return
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ id: org.public_id, name: org.name }))
  } catch {
    /* private window: just ask again next time */
  }
}

export function forgetWorkspace() {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    /* nothing to forget */
  }
}

/** A sign-in link that fills the workspace in: the branded address when there is one. */
export function signInLink(org) {
  if (!org) return ''
  return org.slug ? `${window.location.origin}/w/${org.slug}` : `${window.location.origin}/login?workspace=${org.public_id}`
}
