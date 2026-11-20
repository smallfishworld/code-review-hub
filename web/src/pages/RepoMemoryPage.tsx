import { useId, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type MemoryEntry, type MemoryList } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useConfirm } from '../components/ConfirmDialog';
import { useFlash } from '../components/Toast';

const KIND_LABEL: Record<string, string> = {
  architecture: '架构',
  convention: '约定',
  pitfall: '坑点',
  suppression: '误报抑制',
  history: '历史修复',
  glossary: '术语',
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
  const { id } = useParams<{ id: string }>();
  const repoId = Number(id);
  usePageTitle('项目记忆');
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
        flash.ok('记忆已新增');
      } else {
        await api.put(`/api/repos/${repoId}/memory/${editingId}`, payload);
        flash.ok('记忆已更新');
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
      title: `删除记忆「${m.title}」？`,
      body: '删除后无法恢复；被 suppression 引用的指纹也会失效（同类问题可能复报）。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/repos/${repoId}/memory/${m.id}`);
      flash.ok('已删除');
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
      flash.ok(`markdown 重载完成：更新 ${res.updated} 条，新增 ${res.created} 条`);
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
      flash.ok(`画像已生成：新增 ${res.created} 条，更新 ${res.updated} 条`);
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
        <h1>项目记忆（仓库 #{repoId}）</h1>
        <div className="row-actions">
          <button type="button" className="secondary" onClick={() => void reloadMarkdown()}>
            重载 markdown
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void generateProfile()}
            disabled={profileBusy}
          >
            {profileBusy ? '生成中…' : '生成项目画像'}
          </button>
        </div>
      </div>
      <p className="muted small">
        记忆随评审自动沉淀（LLM 蒸馏 + 误报反馈），也可手工维护；SQLite 为准，markdown（data/memory/{repoId}/）
        为人工编辑入口，编辑后点「重载 markdown」生效。注入预算 1500 token，低置信度（&lt;0.3）条目不参与召回。
        {!memory.data?.ftsAvailable && ' ⚠️ 当前环境 FTS5/trigram 不可用，全文检索降级为 LIKE。'}
      </p>

      <div className="split providers-split">
        <section className="card" aria-labelledby="memory-form-title">
          <h2 id="memory-form-title">{editingId === null ? '新增记忆' : '编辑记忆'}</h2>
          <form className="form" onSubmit={save}>
            <label htmlFor={ids.kind}>
              类型
              <select
                id={ids.kind}
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as MemoryEntry['kind'] })}
              >
                {Object.entries(KIND_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={ids.scope}>
              作用范围（路径前缀，可选）
              <input
                id={ids.scope}
                value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value })}
                placeholder="留空 = 全仓库，例如 src/utils"
              />
            </label>
            <label htmlFor={ids.title}>
              标题
              <input
                id={ids.title}
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                required
              />
            </label>
            <label htmlFor={ids.body}>
              正文
              <textarea
                id={ids.body}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                rows={6}
                required
              />
            </label>
            <label htmlFor={ids.confidence}>
              置信度（0.01–0.99）
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

        <div className="grow">
          <section className="card" aria-labelledby="memory-list-title">
            <h2 id="memory-list-title">记忆条目</h2>
            {memory.data && memory.data.items.length === 0 && (
              <p className="muted">暂无记忆。可点击「生成项目画像」冷启动，或评审后自动沉淀。</p>
            )}
            {memory.data && memory.data.items.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">项目记忆条目</caption>
                  <thead>
                    <tr>
                      <th scope="col">类型</th>
                      <th scope="col">标题</th>
                      <th scope="col">范围</th>
                      <th scope="col">置信度</th>
                      <th scope="col">命中/确认</th>
                      <th scope="col">状态</th>
                      <th scope="col" className="actions-cell">
                        操作
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {memory.data.items.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <span className="tag">{KIND_LABEL[m.kind] ?? m.kind}</span>
                        </td>
                        <td className="ellipsis" title={m.title}>
                          {m.title}
                        </td>
                        <td className="mono small">{m.scope ?? '全仓库'}</td>
                        <td className="small">{m.confidence.toFixed(2)}</td>
                        <td className="small">
                          {m.hits} / {m.feedbackCount}
                        </td>
                        <td>
                          <span className={`tag ${m.status === 'active' ? 'ok' : 'muted'}`}>
                            {m.status === 'active' ? '生效' : m.status === 'archived' ? '归档' : m.status}
                          </span>
                        </td>
                        <td className="actions-cell">
                          <div className="row-actions">
                            <button type="button" className="link" onClick={() => edit(m)}>
                              编辑<span className="visually-hidden">记忆 {m.title}</span>
                            </button>
                            <button type="button" className="link" onClick={() => void toggleStatus(m)}>
                              {m.status === 'active' ? '停用' : '恢复'}
                              <span className="visually-hidden">记忆 {m.title}</span>
                            </button>
                            <button type="button" className="link danger" onClick={() => void remove(m)}>
                              删除<span className="visually-hidden">记忆 {m.title}</span>
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

          <section className="card" aria-labelledby="memory-preview-title">
            <h2 id="memory-preview-title">注入预览</h2>
            <p className="muted small">下一次评审将注入的记忆内容（按得分排序、预算截断后）。</p>
            <pre className="mono small">{preview.data?.text || '（无可注入内容）'}</pre>
          </section>
        </div>
      </div>
    </div>
  );
}
