import { useState } from 'react';
import { api, type Engine } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useConfirm } from '../components/ConfirmDialog';
import { useFlash } from '../components/Toast';

const KINDS = [
  ['ocr', 'ocr（open-code-review CLI）'],
  ['claude-code', 'claude-code（适配器未实现）'],
  ['codex', 'codex（适配器未实现）'],
  ['custom-http', 'custom-http（适配器未实现）'],
  ['custom-script', 'custom-script（适配器未实现）'],
];

export function EnginesPage() {
  usePageTitle('评审引擎');
  const engines = useApi(() => api.get<Engine[]>('/api/engines'));
  const flash = useFlash();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('ocr');
  const [busy, setBusy] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/engines', { name: name.trim(), kind });
      flash.ok('引擎已创建');
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
      flash.ok(`已将「${eng.name}」设为默认评审引擎`);
      await engines.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const remove = async (eng: Engine) => {
    const ok = await confirm({
      title: `删除引擎「${eng.name}」？`,
      body: '被历史任务引用的引擎无法删除，请改为停用。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/engines/${eng.id}`);
      flash.ok('引擎已删除');
      await engines.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>评审引擎</h1>
          <p className="page-subtitle">
            按「监控规则 → 仓库 → 全局默认」三级优先级解析；停用的引擎不回退，任务将失败并写明原因
          </p>
        </div>
      </div>

      <div className="split providers-split">
        <section className="card" aria-labelledby="engine-form-title">
          <h2 id="engine-form-title">新增引擎</h2>
          <form className="form" onSubmit={create}>
            <div className="two-col">
              <label>
                名称
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：ocr-default"
                  required
                />
              </label>
              <label>
                类型
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {KINDS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="actions">
              <button className="primary" type="submit" disabled={busy}>
                保存
              </button>
            </div>
          </form>
        </section>

        <section className="card grow" aria-labelledby="engine-list-title">
          <h2 id="engine-list-title">引擎列表</h2>
          {engines.data && engines.data.length === 0 && <p className="muted">暂无引擎。</p>}
          {engines.data && engines.data.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">评审引擎列表</caption>
                <thead>
                  <tr>
                    <th scope="col">名称</th>
                    <th scope="col">类型</th>
                    <th scope="col">能力</th>
                    <th scope="col">状态</th>
                    <th scope="col" className="actions-cell">
                      操作
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
                            默认
                          </span>
                        )}
                      </td>
                      <td className="small">{eng.kind}</td>
                      <td className="small">
                        {eng.capabilities ? (
                          <>
                            {eng.capabilities.vcs.join('/')} · MCP{' '}
                            {eng.capabilities.mcp === 'none' ? '✗' : '✓'} · 记忆{' '}
                            {eng.capabilities.memoryInjection === 'none' ? '✗' : '✓'}
                          </>
                        ) : (
                          '（适配器未实现）'
                        )}
                      </td>
                      <td>
                        <span className={`tag ${eng.enabled ? 'ok' : 'muted'}`}>
                          {eng.enabled ? '启用' : '停用'}
                        </span>
                      </td>
                      <td className="actions-cell">
                        <div className="row-actions">
                          <button type="button" className="link" onClick={() => void toggle(eng)}>
                            {eng.enabled ? '停用' : '启用'}
                            <span className="visually-hidden">引擎 {eng.name}</span>
                          </button>
                          {!eng.isDefault && eng.enabled && (
                            <button type="button" className="link" onClick={() => void makeDefault(eng)}>
                              设为默认<span className="visually-hidden">引擎 {eng.name}</span>
                            </button>
                          )}
                          <button type="button" className="link danger" onClick={() => void remove(eng)}>
                            删除<span className="visually-hidden">引擎 {eng.name}</span>
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
