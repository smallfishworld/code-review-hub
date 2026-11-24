import { Fragment, useId, useState } from 'react';
import { api, type McpProbeResult, type McpServer } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useConfirm } from '../components/ConfirmDialog';
import { useFlash } from '../components/Toast';

interface FormState {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  scope: 'global' | 'repo';
  repoId: string;
  allowlist: string;
  timeoutSec: number;
}

const empty: FormState = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  env: '',
  url: '',
  headers: '',
  scope: 'global',
  repoId: '',
  allowlist: '',
  timeoutSec: 10,
};

/** Outcome of a connectivity test, kept per server row. */
interface TestState {
  kind: 'pending' | 'ok' | 'fail';
  text: string;
}

export function McpServersPage() {
  usePageTitle('MCP 服务器');
  const servers = useApi(() => api.get<McpServer[]>('/api/mcp-servers'));
  const repos = useApi(() => api.get<{ items: { id: number; name: string }[] }>('/api/repos?limit=200'));
  const flash = useFlash();
  const confirm = useConfirm();
  const [form, setForm] = useState<FormState>(empty);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<Record<number, TestState>>({});
  const ids = {
    name: useId(),
    transport: useId(),
    command: useId(),
    args: useId(),
    env: useId(),
    url: useId(),
    headers: useId(),
    scope: useId(),
    repoId: useId(),
    allowlist: useId(),
    timeoutSec: useId(),
  };

  const edit = (s: McpServer) => {
    setEditingId(s.id);
    const cfg = s.config as Record<string, unknown>;
    setForm({
      name: s.name,
      transport: s.transport,
      command: typeof cfg.command === 'string' ? cfg.command : '',
      args: Array.isArray(cfg.args) ? (cfg.args as string[]).join(' ') : '',
      env: cfg.env ? JSON.stringify(cfg.env, null, 0) : '',
      url: typeof cfg.url === 'string' ? cfg.url : '',
      headers: cfg.headers ? JSON.stringify(cfg.headers, null, 0) : '',
      scope: s.scope,
      repoId: s.repoId ? String(s.repoId) : '',
      allowlist: s.toolAllowlist ? s.toolAllowlist.join(', ') : '',
      timeoutSec: s.timeoutSec,
    });
  };

  const buildPayload = (): Record<string, unknown> | null => {
    let config: Record<string, unknown>;
    if (form.transport === 'stdio') {
      config = { command: form.command.trim() };
      const args = form.args.trim();
      if (args) config.args = args.split(/\s+/);
      if (form.env.trim()) {
        try {
          config.env = JSON.parse(form.env);
        } catch {
          flash.fail('env 必须是 JSON 对象');
          return null;
        }
      }
    } else {
      config = { url: form.url.trim() };
      if (form.headers.trim()) {
        try {
          config.headers = JSON.parse(form.headers);
        } catch {
          flash.fail('headers 必须是 JSON 对象');
          return null;
        }
      }
    }
    const allowlist = form.allowlist
      .split(/[,]/)
      .map((t) => t.trim())
      .filter(Boolean);
    return {
      name: form.name.trim(),
      transport: form.transport,
      config,
      scope: form.scope,
      repoId: form.scope === 'repo' ? Number(form.repoId) : null,
      toolAllowlist: allowlist.length > 0 ? allowlist : null,
      timeoutSec: Number(form.timeoutSec) || 10,
    };
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = buildPayload();
    if (!payload) return;
    setBusy(true);
    try {
      if (editingId === null) {
        await api.post('/api/mcp-servers', payload);
        flash.ok('MCP 服务器已保存');
      } else {
        await api.put(`/api/mcp-servers/${editingId}`, payload);
        flash.ok('MCP 服务器已更新');
      }
      setForm(empty);
      setEditingId(null);
      await servers.reload();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async (s: McpServer) => {
    setTestResult((prev) => ({ ...prev, [s.id]: { kind: 'pending', text: '测试中…' } }));
    try {
      const res = await api.post<McpProbeResult>(`/api/mcp-servers/${s.id}/test`);
      const text = res.ok
        ? `握手成功，工具：${res.tools.length > 0 ? res.tools.join(', ') : '（无）'}`
        : `失败（${res.stage === 'start' ? '启动失败' : res.stage === 'timeout' ? '超时' : '协议错误'}）：${res.error ?? ''}`;
      setTestResult((prev) => ({ ...prev, [s.id]: { kind: res.ok ? 'ok' : 'fail', text } }));
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [s.id]: { kind: 'fail', text: errorText(err) } }));
    }
  };

  const toggle = async (s: McpServer) => {
    try {
      await api.put(`/api/mcp-servers/${s.id}`, { enabled: !s.enabled });
      await servers.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const remove = async (s: McpServer) => {
    const ok = await confirm({
      title: `删除 MCP 服务器「${s.name}」？`,
      body: '删除后无法恢复；绑定了该服务器的仓库将不再注入此 MCP。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/mcp-servers/${s.id}`);
      flash.ok('已删除');
      await servers.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>MCP 服务器</h1>
          <p className="page-subtitle">接入代码图谱与外部上下文工具，按全局或单仓库作用域注入评审流程</p>
        </div>
      </div>
      <div className="alert info" role="note">
        风险提示：MCP 服务器以平台服务账号权限执行命令（stdio）或访问网络地址（http），仅应添加可信来源的 MCP。配置中的 Authorization / token 等敏感值在回显时自动脱敏。
      </div>

      <div className="split providers-split">
        <ServerForm
          form={form}
          setForm={setForm}
          ids={ids}
          editingId={editingId}
          busy={busy}
          save={save}
          cancel={() => {
            setEditingId(null);
            setForm(empty);
          }}
          repos={(repos.data as { items?: { id: number; name: string }[] } | null)?.items ?? []}
        />
        <ServerList
          servers={servers.data ?? []}
          testResult={testResult}
          onEdit={edit}
          onTest={(s) => void test(s)}
          onToggle={(s) => void toggle(s)}
          onRemove={(s) => void remove(s)}
        />
      </div>
    </div>
  );
}

interface FormIds {
  name: string;
  transport: string;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  scope: string;
  repoId: string;
  allowlist: string;
  timeoutSec: string;
}

function ServerForm(props: {
  form: FormState;
  setForm: (f: FormState) => void;
  ids: FormIds;
  editingId: number | null;
  busy: boolean;
  save: (e: React.FormEvent) => void;
  cancel: () => void;
  repos: { id: number; name: string }[];
}) {
  const { form, setForm, ids, editingId, busy, save, cancel, repos } = props;
  return (
    <section className="card" aria-labelledby="mcp-form-title">
      <h2 id="mcp-form-title">{editingId === null ? '新增 MCP 服务器' : '编辑 MCP 服务器'}</h2>
      <form className="form" onSubmit={save}>
        <label htmlFor={ids.name}>
          名称
          <input
            id={ids.name}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="例如：codegraph"
            required
          />
        </label>
        <div className="two-col">
          <label htmlFor={ids.transport}>
            传输类型
            <select
              id={ids.transport}
              value={form.transport}
              onChange={(e) => setForm({ ...form, transport: e.target.value as 'stdio' | 'http' })}
            >
              <option value="stdio">stdio（本地命令）</option>
              <option value="http">http（远程地址）</option>
            </select>
          </label>
          <label htmlFor={ids.timeoutSec}>
            超时秒数
            <input
              id={ids.timeoutSec}
              type="number"
              min={1}
              max={600}
              value={form.timeoutSec}
              onChange={(e) => setForm({ ...form, timeoutSec: Number(e.target.value) || 10 })}
            />
          </label>
        </div>
        {form.transport === 'stdio' ? (
          <>
            <div className="two-col">
              <label htmlFor={ids.command}>
                启动命令
                <input
                  id={ids.command}
                  value={form.command}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                  placeholder="例如：codegraph"
                  required
                />
              </label>
              <label htmlFor={ids.args}>
                参数（空格分隔）
                <input
                  id={ids.args}
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                  placeholder="例如：serve --mcp"
                />
              </label>
            </div>
            <label htmlFor={ids.env}>
              环境变量（JSON，可选）
              <input
                id={ids.env}
                value={form.env}
                onChange={(e) => setForm({ ...form, env: e.target.value })}
                placeholder='{"API_KEY": "..."}'
              />
            </label>
          </>
        ) : (
          <>
            <label htmlFor={ids.url}>
              URL
              <input
                id={ids.url}
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://mcp.example.com/mcp"
                required
              />
            </label>
            <label htmlFor={ids.headers}>
              请求头（JSON，可选）
              <input
                id={ids.headers}
                value={form.headers}
                onChange={(e) => setForm({ ...form, headers: e.target.value })}
                placeholder='{"Authorization": "Bearer ..."}'
              />
            </label>
          </>
        )}
        <div className="two-col">
          <label htmlFor={ids.scope}>
            作用域
            <select
              id={ids.scope}
              value={form.scope}
              onChange={(e) => setForm({ ...form, scope: e.target.value as 'global' | 'repo' })}
            >
              <option value="global">全局（所有仓库）</option>
              <option value="repo">绑定单个仓库</option>
            </select>
          </label>
          {form.scope === 'repo' && (
            <label htmlFor={ids.repoId}>
              绑定仓库
              <select
                id={ids.repoId}
                value={form.repoId}
                onChange={(e) => setForm({ ...form, repoId: e.target.value })}
                required
              >
                <option value="">请选择…</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    #{r.id} {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <label htmlFor={ids.allowlist}>
          工具白名单（逗号分隔，可选）
          <input
            id={ids.allowlist}
            value={form.allowlist}
            onChange={(e) => setForm({ ...form, allowlist: e.target.value })}
            placeholder="留空 = 不限制；ocr 引擎不支持过滤时仅审计标注"
          />
        </label>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            保存
          </button>
          {editingId !== null && (
            <button type="button" className="secondary" onClick={cancel}>
              取消编辑
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function ServerList(props: {
  servers: McpServer[];
  testResult: Record<number, TestState>;
  onEdit: (s: McpServer) => void;
  onTest: (s: McpServer) => void;
  onToggle: (s: McpServer) => void;
  onRemove: (s: McpServer) => void;
}) {
  const { servers, testResult, onEdit, onTest, onToggle, onRemove } = props;
  return (
    <section className="card grow" aria-labelledby="mcp-list-title">
      <h2 id="mcp-list-title">MCP 服务器列表</h2>
      {servers.length === 0 && <p className="muted">暂无 MCP 服务器。</p>}
      {servers.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">MCP 服务器列表</caption>
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">类型</th>
                <th scope="col">目标</th>
                <th scope="col">作用域</th>
                <th scope="col">状态</th>
                <th scope="col" className="actions-cell">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const result = testResult[s.id];
                const cfg = s.config as Record<string, unknown>;
                const target =
                  s.transport === 'stdio'
                    ? String(cfg.command ?? '')
                    : String(cfg.url ?? '');
                return (
                  <Fragment key={s.id}>
                    <tr>
                      <td>{s.name}</td>
                      <td className="small">{s.transport}</td>
                      <td className="mono ellipsis" title={target}>
                        {target}
                      </td>
                      <td className="small">
                        {s.scope === 'global' ? '全局' : `仓库 #${s.repoId}`}
                      </td>
                      <td>
                        <span className={`tag ${s.enabled ? 'ok' : 'muted'}`}>
                          {s.enabled ? '启用' : '停用'}
                        </span>
                      </td>
                      <td className="actions-cell">
                        <div className="row-actions">
                          <button type="button" className="link" onClick={() => onEdit(s)}>
                            编辑<span className="visually-hidden">MCP {s.name}</span>
                          </button>
                          <button
                            type="button"
                            className="link"
                            onClick={() => onTest(s)}
                            disabled={result?.kind === 'pending'}
                          >
                            {result?.kind === 'pending' ? '测试中…' : '连通性测试'}
                            <span className="visually-hidden">MCP {s.name}</span>
                          </button>
                          <button type="button" className="link" onClick={() => onToggle(s)}>
                            {s.enabled ? '停用' : '启用'}
                            <span className="visually-hidden">MCP {s.name}</span>
                          </button>
                          <button type="button" className="link danger" onClick={() => onRemove(s)}>
                            删除<span className="visually-hidden">MCP {s.name}</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                    {result && (
                      <tr className="test-row">
                        <td colSpan={6}>
                          <p className={`test-result ${result.kind}`} role="status" aria-live="polite">
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
  );
}
