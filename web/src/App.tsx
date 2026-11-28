import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { RequireAuth, RequirePermission } from './auth/RequireAuth';
import { ConfirmProvider } from './components/ConfirmDialog';
import { FlashProvider } from './components/Toast';
import { Layout } from './components/Layout';
import { I18nProvider } from './i18n';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { AccountPage } from './pages/AccountPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { ReposPage } from './pages/ReposPage';
import { MonitorPage } from './pages/MonitorPage';
import { TriggerPage } from './pages/TriggerPage';
import { TasksPage, TaskDetailPage } from './pages/TasksPage';
import { ProvidersPage } from './pages/ProvidersPage';
import { EnginesPage } from './pages/EnginesPage';
import { McpServersPage } from './pages/McpServersPage';
import { RepoMemoryPage } from './pages/RepoMemoryPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { LogsPage } from './pages/LogsPage';
import { SettingsPage } from './pages/SettingsPage';
import ShareReportPage from './pages/ShareReportPage';
import './App.css';

export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <FlashProvider>
          <ConfirmProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                {/* Public read-only report view — token in the path is the
                    authorization; deliberately outside the console layout. */}
                <Route path="/share/:token" element={<ShareReportPage />} />
                <Route
                  element={
                    <RequireAuth>
                      <Layout />
                    </RequireAuth>
                  }
                >
                  <Route index element={<Navigate to="/repos" replace />} />
                  <Route path="/repos" element={<ReposPage />} />
                  <Route path="/monitor" element={<MonitorPage />} />
                  <Route
                    path="/trigger"
                    element={
                      <RequirePermission perm="review:trigger">
                        <TriggerPage />
                      </RequirePermission>
                    }
                  />
                  <Route path="/tasks" element={<TasksPage />} />
                  <Route path="/tasks/:id" element={<TaskDetailPage />} />
                  <Route
                    path="/providers"
                    element={
                      <RequirePermission perm="provider:edit">
                        <ProvidersPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/engines"
                    element={
                      <RequirePermission perm="engine:edit">
                        <EnginesPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/mcp"
                    element={
                      <RequirePermission perm="mcp:edit">
                        <McpServersPage />
                      </RequirePermission>
                    }
                  />
                  <Route path="/repos/:id/memory" element={<RepoMemoryPage />} />
                  <Route
                    path="/notifications"
                    element={
                      <RequirePermission perm="notification:edit">
                        <NotificationsPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/logs"
                    element={
                      <RequirePermission perm="log:manage">
                        <LogsPage />
                      </RequirePermission>
                    }
                  />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/account" element={<AccountPage />} />
                  <Route
                    path="/admin/users"
                    element={
                      <RequirePermission perm="user:manage">
                        <AdminUsersPage />
                      </RequirePermission>
                    }
                  />
                </Route>
                <Route path="*" element={<Navigate to="/repos" replace />} />
              </Routes>
            </BrowserRouter>
          </ConfirmProvider>
        </FlashProvider>
      </AuthProvider>
    </I18nProvider>
  );
}
