import { Fragment, useId, useState } from 'react';
import { api, type Provider } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useConfirm } from '../components/ConfirmDialog';
import { useFlash } from '../components/Toast';
import { useI18n } from '../i18n';

interface FormState {
  name: string;
  apiBase: string;
  model: string;
  apiKey: string;
  protocol: string;
}

/** Outcome of a connectivity test, kept per provider row. */
interface TestState {
  kind: 'pending' | 'ok' | 'fail';
  text: string;
}

const empty: FormState = {
  name: '',
  apiBase: '',
  model: '',
  apiKey: '',
  protocol: 'anthropic',
};

const PROTOCOLS = [
  ['anthropic', 'Anthropic Messages API'],
  ['openai', 'OpenAI Chat Completions'],
  ['openai-responses', 'OpenAI Responses API'],
  ['anthropic-bedrock', 'AWS Bedrock (Anthropic)'],
];

export function ProvidersPage() {
  const { t } = useI18n();
  usePageTitle(t('providers.pageTitle'));
  const providers = useApi(() => api.get<Provider[]>('/api/providers'));
  const flash = useFlash();
  const confirm = useConfirm();
  const [form, setForm] = useState<FormState>(empty);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<Record<number, TestState>>({});
  const ids = {
    name: useId(),
    apiBase: useId(),
    model: useId(),
    protocol: useId(),
    apiKey: useId(),
  };

  const edit = (p: Provider) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      apiBase: p.apiBase,
      model: p.model,
      apiKey: '',
      protocol: p.protocol || 'anthropic',
    });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const payload = {
      name: form.name.trim(),
      apiBase: form.apiBase.trim(),
      model: form.model.trim(),
      apiKey: form.apiKey || undefined,
      protocol: form.protocol,
    };
    try {
      if (editingId === null) {
        await api.post('/api/providers', payload);
        flash.ok(t('providers.toast.saved'));
      } else {
        await api.put(`/api/providers/${editingId}`, payload);
        flash.ok(t('providers.toast.updated'));
      }
      setForm(empty);
      setEditingId(null);
      await providers.reload();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async (p: Provider) => {
    setTestResult((prev) => ({
      ...prev,
      [p.id]: { kind: 'pending', text: t('providers.list.testing') },
    }));
    try {
      const res = await api.post<{ ok: boolean; message: string }>(`/api/providers/${p.id}/test`);
      setTestResult((prev) => ({
        ...prev,
        [p.id]: { kind: res.ok ? 'ok' : 'fail', text: res.message },
      }));
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [p.id]: { kind: 'fail', text: errorText(err) } }));
    }
  };

  const makeDefault = async (p: Provider) => {
    try {
      await api.post(`/api/providers/${p.id}/default`);
      flash.ok(t('providers.toast.setDefault', { name: p.name }));
      await providers.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const remove = async (p: Provider) => {
    const ok = await confirm({
      title: t('providers.confirm.deleteTitle', { name: p.name }),
      body: p.isDefault
        ? t('providers.confirm.deleteDefaultBody')
        : t('providers.confirm.deleteBody'),
      confirmLabel: t('providers.confirm.deleteButton'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/providers/${p.id}`);
      flash.ok(t('providers.toast.deleted'));
      await providers.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>{t('providers.pageTitle')}</h1>
          <p className="page-subtitle">{t('providers.subtitle')}</p>
        </div>
      </div>

      <div className="split providers-split">
        <section className="card" aria-labelledby="provider-form-title">
          <h2 id="provider-form-title">
            {editingId === null ? t('providers.form.createTitle') : t('providers.form.editTitle')}
          </h2>
          <form className="form" onSubmit={save}>
            <label htmlFor={ids.name}>
              {t('common.name')}
              <input
                id={ids.name}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('providers.form.namePlaceholder')}
                required
              />
            </label>
            <label htmlFor={ids.apiBase}>
              {t('providers.form.apiBase')}
              <input
                id={ids.apiBase}
                value={form.apiBase}
                onChange={(e) => setForm({ ...form, apiBase: e.target.value })}
                placeholder="https://api.example.com/v1"
                required
              />
            </label>
            <div className="two-col">
              <label htmlFor={ids.model}>
                {t('providers.form.model')}
                <input
                  id={ids.model}
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  placeholder="gpt-4o / claude-sonnet"
                  required
                />
              </label>
              <label htmlFor={ids.protocol}>
                {t('providers.form.protocol')}
                <select
                  id={ids.protocol}
                  value={form.protocol}
                  onChange={(e) => setForm({ ...form, protocol: e.target.value })}
                >
                  {PROTOCOLS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label htmlFor={ids.apiKey}>
              {t('providers.form.apiKey')}
              <input
                id={ids.apiKey}
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder={editingId === null ? '' : t('common.leaveBlankUnchanged')}
                autoComplete="new-password"
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

        <section className="card grow" aria-labelledby="provider-list-title">
          <h2 id="provider-list-title">{t('providers.list.title')}</h2>
          {providers.data && providers.data.length === 0 && (
            <p className="muted">{t('providers.list.empty')}</p>
          )}
          {providers.data && providers.data.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">{t('providers.list.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('common.name')}</th>
                    <th scope="col">{t('providers.form.apiBase')}</th>
                    <th scope="col">{t('providers.list.colModel')}</th>
                    <th scope="col">{t('providers.form.protocol')}</th>
                    <th scope="col">Key</th>
                    <th scope="col" className="actions-cell">
                      {t('common.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {providers.data.map((p) => {
                    const result = testResult[p.id];
                    return (
                      <Fragment key={p.id}>
                        <tr>
                          <td>{p.name}</td>
                          <td className="mono ellipsis" title={p.apiBase}>
                            {p.apiBase}
                          </td>
                          <td>
                            {p.model}
                            {p.isDefault && (
                              <span className="tag ok" style={{ marginLeft: 6 }}>
                                {t('common.default')}
                              </span>
                            )}
                          </td>
                          <td className="small">{p.protocol}</td>
                          <td className="mono">{p.apiKey || '—'}</td>
                          <td className="actions-cell">
                            <div className="row-actions">
                              <button type="button" className="link" onClick={() => edit(p)}>
                                {t('common.edit')}
                                <span className="visually-hidden">Provider {p.name}</span>
                              </button>
                              <button
                                type="button"
                                className="link"
                                onClick={() => void test(p)}
                                disabled={result?.kind === 'pending'}
                              >
                                {result?.kind === 'pending'
                                  ? t('providers.list.testing')
                                  : t('providers.list.test')}
                                <span className="visually-hidden">Provider {p.name}</span>
                              </button>
                              {!p.isDefault && (
                                <button
                                  type="button"
                                  className="link"
                                  onClick={() => void makeDefault(p)}
                                >
                                  {t('common.setDefault')}
                                  <span className="visually-hidden">Provider {p.name}</span>
                                </button>
                              )}
                              <button
                                type="button"
                                className="link danger"
                                onClick={() => void remove(p)}
                              >
                                {t('common.delete')}
                                <span className="visually-hidden">Provider {p.name}</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                        {result && (
                          <tr className="test-row">
                            <td colSpan={6}>
                              <p
                                className={`test-result ${result.kind}`}
                                role="status"
                                aria-live="polite"
                              >
                                <span className="test-result-label">
                                  {result.kind === 'ok'
                                    ? t('providers.list.testOk')
                                    : result.kind === 'fail'
                                      ? t('providers.list.testFail')
                                      : t('providers.list.testPending')}
                                  :{' '}
                                </span>
                                {result.text}
                              </p>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
