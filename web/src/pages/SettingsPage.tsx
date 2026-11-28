import { useState } from 'react';
import { api, type DepInfo, type DepRepairResult } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { usePermission } from '../auth/AuthContext';
import { useFlash } from '../components/Toast';
import { LanguageSwitcher, useI18n } from '../i18n';

/** Settings: interface language + runtime dependency inspection and official-channel repair. */
export function SettingsPage() {
  const { t } = useI18n();
  usePageTitle(t('settings.pageTitle'));
  const deps = useApi(() => api.get<{ results: DepInfo[]; ok: boolean }>('/api/deps'));
  const canRepair = usePermission('engine:edit');
  const flash = useFlash();
  const [checking, setChecking] = useState(false);
  const [repairingCmd, setRepairingCmd] = useState<string | null>(null);
  const [lastRepair, setLastRepair] = useState<DepRepairResult | null>(null);

  const recheckDeps = async () => {
    setChecking(true);
    try {
      const res = await api.post<{ results: DepInfo[]; ok: boolean }>('/api/deps/check');
      deps.setData(res);
      flash.ok(res.ok ? t('settings.deps.toastOk') : t('settings.deps.toastFail'));
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setChecking(false);
    }
  };

  const repairDep = async (command: string) => {
    setRepairingCmd(command);
    setLastRepair(null);
    try {
      const res = await api.post<DepRepairResult>(`/api/deps/${encodeURIComponent(command)}/repair`);
      setLastRepair(res);
      deps.setData(res.report);
      if (res.ok) {
        flash.ok(t('settings.deps.repairOkToast', { command }));
      } else {
        flash.fail(res.error ?? t('settings.deps.repairFailToast', { command }));
      }
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setRepairingCmd(null);
    }
  };

  const localizedDepNote = (dep: DepInfo): string | null => {
    if (dep.command === 'ocr') return t('settings.deps.note.ocr');
    if (dep.command === 'svn') return t('settings.deps.note.svn');
    return dep.note ?? null;
  };

  const localizedDepError = (dep: DepInfo): string | null => {
    if (!dep.error) return null;
    const m = /版本过低：需要\s*>=\s*([^\s，,]+)[，,]\s*当前\s*(.+)/.exec(dep.error);
    if (m) {
      return t('settings.deps.versionTooLow', { minVersion: m[1], actual: m[2] });
    }
    return dep.error;
  };

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>{t('settings.pageTitle')}</h1>
          <p className="page-subtitle">{t('settings.subtitle')}</p>
        </div>
      </div>

      <section className="card trigger-rule-card" aria-labelledby="lang-setting-title">
        <div className="trigger-rule-head">
          <h2 id="lang-setting-title">{t('settings.lang.title')}</h2>
          <span className="muted small">{t('settings.lang.subtitle')}</span>
        </div>
        <LanguageSwitcher />
      </section>

      <section className="card" aria-labelledby="deps-title">
        <div className="card-head">
          <h2 id="deps-title">{t('settings.deps.title')}</h2>
          <button
            type="button"
            className="secondary small"
            onClick={() => void recheckDeps()}
            disabled={checking || repairingCmd !== null}
          >
            {checking ? t('settings.deps.checking') : t('settings.deps.recheck')}
          </button>
        </div>
        {deps.loading && <p className="muted">{t('settings.deps.checking')}</p>}
        {repairingCmd && (
          <div className="alert info" role="status">
            {t('settings.deps.repairingBanner', { command: repairingCmd })}
          </div>
        )}
        {deps.error && (
          <div className="alert error" role="alert">
            {deps.error}
          </div>
        )}
        {deps.data && (
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">{t('settings.deps.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('settings.deps.colCommand')}</th>
                  <th scope="col">{t('common.status')}</th>
                  <th scope="col">{t('settings.deps.colVersion')}</th>
                  <th scope="col">{t('settings.deps.colNote')}</th>
                  <th scope="col" className="actions-cell">
                    {t('common.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {deps.data.results.map((dep) => {
                  const healthy = dep.found && dep.executable;
                  const isRepairing = repairingCmd === dep.command;
                  const noteText = localizedDepNote(dep);
                  const errText = localizedDepError(dep);
                  return (
                    <tr key={dep.command}>
                      <td className="mono">{dep.command}</td>
                      <td>
                        <span className={healthy ? 'tag ok' : 'tag failed'}>
                          {healthy ? t('settings.deps.available') : t('settings.deps.unavailable')}
                        </span>
                      </td>
                      <td className="small">{dep.version ?? '—'}</td>
                      <td className="small dep-note-cell">
                        <div>
                          {dep.conditional ? t('settings.deps.conditional') : t('settings.deps.required')}
                          {dep.minVersion ? t('settings.deps.minVersion', { version: dep.minVersion }) : ''}
                        </div>
                        {noteText && <div className="muted">{noteText}</div>}
                        {errText && <div className="dep-note-error">{errText}</div>}
                      </td>
                      <td className="actions-cell">
                        {!healthy ? (
                          <div className="row-actions">
                            {canRepair && (
                              <button
                                type="button"
                                className="primary small"
                                disabled={repairingCmd !== null || checking}
                                onClick={() => void repairDep(dep.command)}
                              >
                                {isRepairing ? t('settings.deps.repairing') : t('settings.deps.repair')}
                              </button>
                            )}
                            {dep.officialUrl && (
                              <a
                                href={dep.officialUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="small"
                              >
                                {t('settings.deps.officialDownload')}
                              </a>
                            )}
                          </div>
                        ) : (
                          <span className="small muted">{t('settings.deps.healthy')}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {lastRepair && (
          <div style={{ marginTop: 16 }}>
            <div className={`alert ${lastRepair.ok ? 'ok' : 'warn'}`} role="status">
              <div>
                <strong>
                  {lastRepair.ok
                    ? t('settings.deps.repairOkTitle', { command: lastRepair.command })
                    : t('settings.deps.repairFailTitle', { command: lastRepair.command })}
                </strong>
                {lastRepair.method && (
                  <div className="small">
                    {t('settings.deps.execCmd')}
                    <code>{lastRepair.method}</code>
                  </div>
                )}
                {lastRepair.error && <div className="small">{lastRepair.error}</div>}
                {!lastRepair.ok && lastRepair.manualCommand && (
                  <div className="small" style={{ marginTop: 6 }}>
                    {t('settings.deps.manualCmd')}
                    <code>{lastRepair.manualCommand}</code>
                    {lastRepair.officialUrl && (
                      <>
                        {' · '}
                        <a href={lastRepair.officialUrl} target="_blank" rel="noreferrer">
                          {t('settings.deps.goOfficial')}
                        </a>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
            {lastRepair.output && (
              <details open={!lastRepair.ok}>
                <summary className="small">{t('settings.deps.viewOutput')}</summary>
                <pre className="raw">{lastRepair.output}</pre>
              </details>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
