import { useState } from 'react';
import { api, type Engine } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useConfirm } from '../components/ConfirmDialog';
import { useFlash } from '../components/Toast';
import { useI18n } from '../i18n';

const KIND_VALUES = ['ocr', 'claude-code', 'codex', 'custom-http', 'custom-script'] as const;

export function EnginesPage() {
  const { t } = useI18n();
  usePageTitle(t('engines.pageTitle'));
  const engines = useApi(() => api.get<Engine[]>('/api/engines'));
  const flash = useFlash();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('ocr');
  const [busy, setBusy] = useState(false);

  const kindLabel = (value: string) =>
    value === 'ocr' ? t('engines.kind.ocr') : t('engines.kind.unimplemented', { kind: value });

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/engines', { name: name.trim(), kind });
      flash.ok(t('engines.toast.created'));
      setName('');
      await engines.reload();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (eng: Engine) => {
    try {
      await api.put(`/api/engines/${eng.id}`, { enabled: !eng.enabled });
      await engines.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const makeDefault = async (eng: Engine) => {
    try {
      await api.post(`/api/engines/${eng.id}/default`);
      flash.ok(t('engines.toast.setDefault', { name: eng.name }));
      await engines.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const remove = async (eng: Engine) => {
    const ok = await confirm({
      title: t('engines.confirm.deleteTitle', { name: eng.name }),
      body: t('engines.confirm.deleteBody'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/engines/${eng.id}`);
      flash.ok(t('engines.toast.deleted'));
      await engines.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>{t('engines.pageTitle')}</h1>
          <p className="page-subtitle">{t('engines.subtitle')}</p>
        </div>
      </div>

      <div className="split providers-split">
        <section className="card" aria-labelledby="engine-form-title">
          <h2 id="engine-form-title">{t('engines.form.title')}</h2>
          <form className="form" onSubmit={create}>
            <div className="two-col">
              <label>
                {t('common.name')}
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('engines.form.namePlaceholder')}
                  required
                />
              </label>
              <label>
                {t('common.type')}
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {KIND_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {kindLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="actions">
              <button className="primary" type="submit" disabled={busy}>
                {t('common.save')}
              </button>
            </div>
          </form>
        </section>

        <section className="card grow" aria-labelledby="engine-list-title">
          <h2 id="engine-list-title">{t('engines.list.title')}</h2>
          {engines.data && engines.data.length === 0 && (
            <p className="muted">{t('engines.list.empty')}</p>
          )}
          {engines.data && engines.data.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">{t('engines.list.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('common.name')}</th>
                    <th scope="col">{t('common.type')}</th>
                    <th scope="col">{t('engines.list.colCapabilities')}</th>
                    <th scope="col">{t('common.status')}</th>
                    <th scope="col" className="actions-cell">
                      {t('common.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {engines.data.map((eng) => (
                    <tr key={eng.id}>
                      <td>
                        {eng.name}
                        {eng.isDefault && (
                          <span className="tag ok" style={{ marginLeft: 6 }}>
                            {t('common.default')}
                          </span>
                        )}
                      </td>
                      <td className="small">{eng.kind}</td>
                      <td className="small">
                        {eng.capabilities ? (
                          <>
                            {eng.capabilities.vcs.join('/')} · MCP{' '}
                            {eng.capabilities.mcp === 'none' ? '✗' : '✓'} · {t('engines.list.memoryCap')}{' '}
                            {eng.capabilities.memoryInjection === 'none' ? '✗' : '✓'}
                          </>
                        ) : (
                          t('engines.list.adapterMissing')
                        )}
                      </td>
                      <td>
                        <span className={`tag ${eng.enabled ? 'ok' : 'muted'}`}>
                          {eng.enabled ? t('common.enabled') : t('common.disabled')}
                        </span>
                      </td>
                      <td className="actions-cell">
                        <div className="row-actions">
                          <button type="button" className="link" onClick={() => void toggle(eng)}>
                            {eng.enabled ? t('common.disable') : t('common.enable')}
                            <span className="visually-hidden">
                              {t('engines.list.srEngine', { name: eng.name })}
                            </span>
                          </button>
                          {!eng.isDefault && eng.enabled && (
                            <button
                              type="button"
                              className="link"
                              onClick={() => void makeDefault(eng)}
                            >
                              {t('common.setDefault')}
                              <span className="visually-hidden">
                                {t('engines.list.srEngine', { name: eng.name })}
                              </span>
                            </button>
                          )}
                          <button
                            type="button"
                            className="link danger"
                            onClick={() => void remove(eng)}
                          >
                            {t('common.delete')}
                            <span className="visually-hidden">
                              {t('engines.list.srEngine', { name: eng.name })}
                            </span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
