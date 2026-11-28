import { useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type MemoryEntry, type MemoryList } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { usePermission } from '../auth/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import { useFlash } from '../components/Toast';
import { useI18n, type MessageKey } from '../i18n';

const KIND_KEYS: Record<MemoryEntry['kind'], MessageKey> = {
  architecture: 'memory.kind.architecture',
  convention: 'memory.kind.convention',
  pitfall: 'memory.kind.pitfall',
  suppression: 'memory.kind.suppression',
  history: 'memory.kind.history',
  glossary: 'memory.kind.glossary',
};

interface FormState {
  kind: MemoryEntry['kind'];
  scope: string;
  title: string;
  body: string;
  confidence: number;
}

const empty: FormState = {
  kind: 'convention',
  scope: '',
  title: '',
  body: '',
  confidence: 0.5,
};

export function RepoMemoryPage() {
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();
  const repoId = Number(id);
  const canEdit = usePermission('memory:edit');
  usePageTitle(t('memory.pageTitle'));
  const memory = useApi(() => api.get<MemoryList>(`/api/repos/${repoId}/memory?status=all`));
  const preview = useApi(() =>
    api.get<{ text: string; count: number }>(`/api/repos/${repoId}/memory/preview`)
  );
  const flash = useFlash();
  const confirm = useConfirm();
  const [form, setForm] = useState<FormState>(empty);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const ids = {
    kind: useId(),
    scope: useId(),
    title: useId(),
    body: useId(),
    confidence: useId(),
  };

  const edit = (m: MemoryEntry) => {
    setEditingId(m.id);
    setForm({
      kind: m.kind,
      scope: m.scope ?? '',
      title: m.title,
      body: m.body,
      confidence: m.confidence,
    });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const payload = {
      kind: form.kind,
      scope: form.scope.trim() || null,
      title: form.title.trim(),
      body: form.body.trim(),
      confidence: form.confidence,
    };
    try {
      if (editingId === null) {
        await api.post(`/api/repos/${repoId}/memory`, payload);
        flash.ok(t('memory.toast.created'));
      } else {
        await api.put(`/api/repos/${repoId}/memory/${editingId}`, payload);
        flash.ok(t('memory.toast.updated'));
      }
      setForm(empty);
      setEditingId(null);
      await Promise.all([memory.reload(), preview.reload()]);
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (m: MemoryEntry) => {
    try {
      await api.put(`/api/repos/${repoId}/memory/${m.id}`, {
        status: m.status === 'active' ? 'archived' : 'active',
      });
      await memory.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const remove = async (m: MemoryEntry) => {
    const ok = await confirm({
      title: t('memory.confirm.deleteTitle', { title: m.title }),
      body: t('memory.confirm.deleteBody'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/repos/${repoId}/memory/${m.id}`);
      flash.ok(t('common.deleted'));
      await memory.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const reloadMarkdown = async () => {
    try {
      const res = await api.post<{ updated: number; created: number }>(
        `/api/repos/${repoId}/memory/reload`
      );
      flash.ok(t('memory.toast.reloaded', { updated: res.updated, created: res.created }));
      await memory.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const generateProfile = async () => {
    setProfileBusy(true);
    try {
      const res = await api.post<{ updated: number; created: number }>(
        `/api/repos/${repoId}/memory/profile`
      );
      flash.ok(t('memory.toast.profileGenerated', { created: res.created, updated: res.updated }));
      await Promise.all([memory.reload(), preview.reload()]);
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setProfileBusy(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <Link to="/repos" className="back-link">
            {t('memory.back')}
          </Link>
          <h1>{t('memory.heading', { id: repoId })}</h1>
          <p className="page-subtitle">{t('memory.subtitle', { id: repoId })}</p>
        </div>
        {canEdit && (
          <div className="row-actions">
            <button type="button" className="secondary" onClick={() => void reloadMarkdown()}>
              {t('memory.reloadMarkdown')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void generateProfile()}
              disabled={profileBusy}
            >
              {profileBusy ? t('memory.generatingProfile') : t('memory.generateProfile')}
            </button>
          </div>
        )}
      </div>
      {memory.data && !memory.data.ftsAvailable && (
        <div className="alert info">{t('memory.ftsFallback')}</div>
      )}

      <div className={canEdit ? 'split providers-split' : 'stack'}>
        {canEdit && (
        <section className="card" aria-labelledby="memory-form-title">
          <h2 id="memory-form-title">
            {editingId === null ? t('memory.form.createTitle') : t('memory.form.editTitle')}
          </h2>
          <form className="form" onSubmit={save}>
            <div className="two-col">
              <label htmlFor={ids.kind}>
                {t('common.type')}
                <select
                  id={ids.kind}
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value as MemoryEntry['kind'] })}
                >
                  {(Object.entries(KIND_KEYS) as [MemoryEntry['kind'], MessageKey][]).map(
                    ([value, key]) => (
                      <option key={value} value={value}>
                        {t(key)}
                      </option>
                    )
                  )}
                </select>
              </label>
              <label htmlFor={ids.confidence}>
                {t('memory.form.confidence')}
                <input
                  id={ids.confidence}
                  type="number"
                  step="0.01"
                  min={0.01}
                  max={0.99}
                  value={form.confidence}
                  onChange={(e) => setForm({ ...form, confidence: Number(e.target.value) })}
                />
              </label>
            </div>
            <label htmlFor={ids.scope}>
              {t('memory.form.scope')}
              <input
                id={ids.scope}
                value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value })}
                placeholder={t('memory.form.scopePlaceholder')}
              />
            </label>
            <label htmlFor={ids.title}>
              {t('memory.form.title')}
              <input
                id={ids.title}
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                required
              />
            </label>
            <label htmlFor={ids.body}>
              {t('memory.form.body')}
              <textarea
                id={ids.body}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                rows={6}
                required
              />
            </label>
            <div className="actions">
              <button className="primary" type="submit" disabled={busy}>
                {t('common.save')}
              </button>
              {editingId !== null && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setEditingId(null);
                    setForm(empty);
                  }}
                >
                  {t('common.cancelEdit')}
                </button>
              )}
            </div>
          </form>
        </section>
        )}

        <div className="grow stack">
          <section className="card" aria-labelledby="memory-list-title">
            <h2 id="memory-list-title">{t('memory.list.title')}</h2>
            {memory.data && memory.data.items.length === 0 && (
              <p className="muted">{t('memory.list.empty')}</p>
            )}
            {memory.data && memory.data.items.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">{t('memory.list.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('common.type')}</th>
                      <th scope="col">{t('memory.list.colTitle')}</th>
                      <th scope="col">{t('memory.list.colScope')}</th>
                      <th scope="col">{t('memory.list.colConfidence')}</th>
                      <th scope="col">{t('memory.list.colHits')}</th>
                      <th scope="col">{t('common.status')}</th>
                      <th scope="col" className="actions-cell">
                        {t('common.actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {memory.data.items.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <span className="tag">
                            {KIND_KEYS[m.kind] ? t(KIND_KEYS[m.kind]) : m.kind}
                          </span>
                        </td>
                        <td className="ellipsis" title={m.title}>
                          {m.title}
                        </td>
                        <td className="mono small">{m.scope ?? t('memory.list.allRepo')}</td>
                        <td className="small">{m.confidence.toFixed(2)}</td>
                        <td className="small">
                          {m.hits} / {m.feedbackCount}
                        </td>
                        <td>
                          <span className={`tag ${m.status === 'active' ? 'ok' : 'muted'}`}>
                            {m.status === 'active'
                              ? t('memory.list.statusActive')
                              : m.status === 'archived'
                                ? t('memory.list.statusArchived')
                                : m.status}
                          </span>
                        </td>
                        <td className="actions-cell">
                          {canEdit ? (
                            <div className="row-actions">
                              <button type="button" className="link" onClick={() => edit(m)}>
                                {t('common.edit')}
                                <span className="visually-hidden">
                                  {t('memory.list.srMemory', { title: m.title })}
                                </span>
                              </button>
                              <button
                                type="button"
                                className="link"
                                onClick={() => void toggleStatus(m)}
                              >
                                {m.status === 'active'
                                  ? t('common.disable')
                                  : t('memory.list.restore')}
                                <span className="visually-hidden">
                                  {t('memory.list.srMemory', { title: m.title })}
                                </span>
                              </button>
                              <button
                                type="button"
                                className="link danger"
                                onClick={() => void remove(m)}
                              >
                                {t('common.delete')}
                                <span className="visually-hidden">
                                  {t('memory.list.srMemory', { title: m.title })}
                                </span>
                              </button>
                            </div>
                          ) : (
                            <span className="small muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="memory-preview-title">
            <h2 id="memory-preview-title">{t('memory.preview.title')}</h2>
            <p className="muted small">{t('memory.preview.subtitle')}</p>
            <pre className="raw">{preview.data?.text || t('memory.preview.empty')}</pre>
          </section>
        </div>
      </div>
    </div>
  );
}
