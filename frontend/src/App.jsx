import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './context'
import { Spinner } from './ui'
import Layout from './components/Layout'
import { ChangePassword, ForgotPassword, Login, Signup } from './pages/AuthPages'
import Billing from './pages/Billing'
import Platform from './pages/Platform'
import Support from './pages/Support'
import { Landing, Legal, SharedProject, StatusPage } from './pages/Public'
import Dashboard from './pages/Dashboard'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import MyIssues from './pages/MyIssues'
import Roadmap from './pages/Roadmap'
import Calendar from './pages/Calendar'
import Chat from './pages/Chat'
import Timesheet from './pages/Timesheet'
import { Portfolio, RecycleBin, Workload } from './pages/Insights'
import Users from './pages/Users'
import Profile from './pages/Profile'

function RequireAuth() {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <Spinner page />
  // Visitors who open the site itself see what the product is; deep links go to sign-in.
  if (!user && location.pathname === '/') return <Navigate to="/welcome" replace />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  if (user.must_change_password) return <Navigate to="/change-password" replace />
  return <Outlet />
}

function PublicOnly() {
  const { user, loading } = useAuth()
  if (loading) return <Spinner page />
  if (user) return <Navigate to={user.must_change_password ? '/change-password' : '/'} replace />
  return <Outlet />
}

function RequireAdmin() {
  const { user } = useAuth()
  return user.role === 'admin' ? <Outlet /> : <Navigate to="/" replace />
}

function RequirePlatformOwner() {
  const { user } = useAuth()
  return user.is_platform_admin ? <Outlet /> : <Navigate to="/" replace />
}

export default function App() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/w/:slug" element={<Login />} />
        <Route path="/welcome" element={<Landing />} />
      </Route>
      <Route path="/terms" element={<Legal kind="terms" />} />
      <Route path="/privacy" element={<Legal kind="privacy" />} />
      <Route path="/share/:token" element={<SharedProject />} />
      <Route path="/status" element={<StatusPage />} />
      <Route path="/change-password" element={<ChangePassword />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:projectId" element={<ProjectDetail />} />
          <Route path="my-issues" element={<MyIssues />} />
          <Route path="roadmap" element={<Roadmap />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="chat" element={<Chat />} />
          <Route path="timesheet" element={<Timesheet />} />
          <Route path="workload" element={<Workload />} />
          <Route path="portfolio" element={<Portfolio />} />
          <Route path="trash" element={<RecycleBin />} />
          <Route path="profile" element={<Profile />} />
          <Route path="support" element={<Support />} />
          <Route element={<RequireAdmin />}>
            <Route path="users" element={<Users />} />
            <Route path="billing" element={<Billing />} />
          </Route>
          <Route element={<RequirePlatformOwner />}>
            <Route path="platform" element={<Platform />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
