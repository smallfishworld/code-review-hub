import type { NotificationContext } from './types.js';

/**
 * Text/HTML rendering for notification messages (email body, chat default
 * template). Values are escaped in HTML so repository names or commit
 * messages can never inject markup.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const STATUS_LABELS: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  running: '执行中',
  queued: '排队中',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Render the review-result email (subject + plain text + HTML). */
export function renderEmail(context: NotificationContext): RenderedEmail {
  const label = statusLabel(context.status);
  const subject = `【代码评审】${context.repo} ${context.node} ${label}`;
  const lines = [
    `仓库：${context.repo}`,
    `节点：${context.node}`,
    `上库人员：${context.author || '未知'}`,
    `任务状态：${label}`,
    `评审摘要：${context.summary}`,
    `报告链接：${context.report_url}`,
  ];
  const text = lines.join('\n');
  const html = [
    '<div style="font-family:sans-serif;line-height:1.6">',
    `<h3 style="margin:0 0 12px">${escapeHtml(subject)}</h3>`,
    '<table cellpadding="4" style="border-collapse:collapse">',
    row('仓库', context.repo),
    row('节点', context.node),
    row('上库人员', context.author || '未知'),
    row('任务状态', label),
    row('评审摘要', context.summary),
    `<tr><td style="color:#666">报告链接</td><td><a href="${escapeHtml(
      context.report_url
    )}">${escapeHtml(context.report_url)}</a></td></tr>`,
    '</table>',
    '</div>',
  ].join('');
  return { subject, text, html };
}

function row(label: string, value: string): string {
  return `<tr><td style="color:#666;white-space:nowrap">${escapeHtml(
    label
  )}</td><td>${escapeHtml(value)}</td></tr>`;
}
