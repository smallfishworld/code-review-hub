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
        flash.ok(`依赖「${command}」已通过官方渠道修复并检测通过`);
      } else {
        flash.fail(res.error ?? `依赖「${command}」自动修复未完成`);
      }
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setRepairingCmd(null);
    }
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
          <h2 id="lang-setting-title">界面语言 / Language</h2>
          <span className="muted small">切换控制台的显示语言，设置保存在当前浏览器中。</span>
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
            正在通过官方渠道下载并安装「{repairingCmd}」，可能需要几十秒，请勿关闭页面…
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
                  return (
                    <tr key={dep.command}>
                      <td className="mono">{dep.command}</td>
                      <td>
                        <span className={healthy ? 'tag ok' : 'tag failed'}>
                          {healthy ? t('settings.deps.available') : t('settings.deps.unavailable')}
                        </span>
                      </td>
                      <td className="small">{dep.version ?? '—'}</td>
                      <td className="small">
                        {dep.conditional ? t('settings.deps.conditional') : t('settings.deps.required')}
                        {dep.minVersion ? t('settings.deps.minVersion', { version: dep.minVersion }) : ''}
                        {dep.note ? `: ${dep.note}` : ''}
                        {dep.error ? `: ${dep.error}` : ''}
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
                                {isRepairing ? '正在从官方渠道修复…' : '修复'}
                              </button>
                            )}
                            {dep.officialUrl && (
                              <a
                                href={dep.officialUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="small"
                              >
                                官方下载
                              </a>
                            )}
                          </div>
                        ) : (
                          <span className="small muted">正常</span>
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
                    ? `依赖「${lastRepair.command}」修复成功`
                    : `依赖「${lastRepair.command}」未完成自动修复`}
                </strong>
                {lastRepair.method && (
                  <div className="small">执行命令：<code>{lastRepair.method}</code></div>
                )}
                {lastRepair.error && <div className="small">{lastRepair.error}</div>}
                {!lastRepair.ok && lastRepair.manualCommand && (
                  <div className="small" style={{ marginTop: 6 }}>
                    官方安装命令：<code>{lastRepair.manualCommand}</code>
                    {lastRepair.officialUrl && (
                      <>
                        {' · '}
                        <a href={lastRepair.officialUrl} target="_blank" rel="noreferrer">
                          前往官方下载页
                        </a>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
            {lastRepair.output && (
              <details open={!lastRepair.ok}>
                <summary className="small">查看安装输出日志</summary>
                <pre className="raw">{lastRepair.output}</pre>
              </details>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
