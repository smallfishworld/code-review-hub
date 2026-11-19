import { Fragment, useId, useState } from 'react';
import { api, type Provider } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useConfirm } from '../components/ConfirmDialog';
import { useFlash } from '../components/Toast';

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
  usePageTitle('LLM Provider');
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
        flash.ok('Provider 已保存');
      } else {
        await api.put(`/api/providers/${editingId}`, payload);
        flash.ok('Provider 已更新');
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
    setTestResult((prev) => ({ ...prev, [p.id]: { kind: 'pending', text: '测试中…' } }));
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
      flash.ok(`已将「${p.name}」设为默认评审 Provider`);
      await providers.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const remove = async (p: Provider) => {
    const ok = await confirm({
      title: `删除 Provider「${p.name}」？`,
      body: p.isDefault
        ? '这是当前的默认评审 Provider，删除后需重新指定一个，否则评审任务将无法执行。'
        : '删除后无法恢复，已保存的 API Key 会一并删除。',
      confirmLabel: '删除 Provider',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/providers/${p.id}`);
      flash.ok('Provider 已删除');
      await providers.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  return (
    <div>
      <div className="page-head">
        <h1>LLM Provider</h1>
      </div>

      <div className="split providers-split">
        <section className="card" aria-labelledby="provider-form-title">
          <h2 id="provider-form-title">{editingId === null ? '新增 Provider' : '编辑 Provider'}</h2>
          <form className="form" onSubmit={save}>
            <label htmlFor={ids.name}>
              名称
              <input
                id={ids.name}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </label>
            <label htmlFor={ids.apiBase}>
              API 地址
              <input
                id={ids.apiBase}
                value={form.apiBase}
                onChange={(e) => setForm({ ...form, apiBase: e.target.value })}
                placeholder="https://api.example.com/v1"
                required
              />
            </label>
            <label htmlFor={ids.model}>
              模型名
              <input
                id={ids.model}
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder="例如：gpt-4o / claude-sonnet"
                required
              />
            </label>
            <label htmlFor={ids.protocol}>
              协议
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
            <label htmlFor={ids.apiKey}>
              API Key
              <input
                id={ids.apiKey}
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder={editingId === null ? '' : '留空表示不修改'}
                autoComplete="new-password"
              />
            </label>
            <div className="actions">
              <button className="primary" type="submit" disabled={busy}>
                保存
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
                  取消编辑
                </button>
              )}
            </div>
          </form>
        </section>

        <section className="card grow" aria-labelledby="provider-list-title">
          <h2 id="provider-list-title">Provider 列表</h2>
          {providers.data && providers.data.length === 0 && <p className="muted">暂无 Provider。</p>}
          {providers.data && providers.data.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">LLM Provider 列表</caption>
                <thead>
                  <tr>
                    <th scope="col">名称</th>
                    <th scope="col">API 地址</th>
                    <th scope="col">模型</th>
                    <th scope="col">协议</th>
                    <th scope="col">Key</th>
                    <th scope="col" className="actions-cell">
                      操作
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
                                默认
                              </span>
                            )}
                          </td>
                          <td className="small">{p.protocol}</td>
                          <td className="mono">{p.apiKey || '—'}</td>
                          <td className="actions-cell">
                            <div className="row-actions">
                              <button type="button" className="link" onClick={() => edit(p)}>
                                编辑<span className="visually-hidden">Provider {p.name}</span>
                              </button>
                              <button
                                type="button"
                                className="link"
                                onClick={() => void test(p)}
                                disabled={result?.kind === 'pending'}
                              >
                                {result?.kind === 'pending' ? '测试中…' : '测试连接'}
                                <span className="visually-hidden">Provider {p.name}</span>
                              </button>
                              {!p.isDefault && (
                                <button
                                  type="button"
                                  className="link"
                                  onClick={() => void makeDefault(p)}
                                >
                                  设为默认<span className="visually-hidden">Provider {p.name}</span>
                                </button>
                              )}
                              <button
                                type="button"
                                className="link danger"
                                onClick={() => void remove(p)}
                              >
                                删除<span className="visually-hidden">Provider {p.name}</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                        {/* The test verdict gets its own full-width row: inside
                            the action cell it competed with four links for a
                            narrow column and wrapped into an unreadable stack. */}
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
                                    ? '成功'
                                    : result.kind === 'fail'
                                      ? '失败'
                                      : '测试中'}
                                  ：
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
