/**
 * RBAC permission definitions and route-to-permission policy.
 *
 * Every `/api/*` endpoint is classified into one of:
 *   - 'public'        : accessible without login (health, auth bootstrap/login/register, share tokens)
 *   - 'authenticated' : accessible to any active logged-in user (read-only views + self account)
 *   - Permission      : requires the named permission (or super admin)
 *   - 'super_admin'   : fallback default-deny for any unmapped route
 */

export type Permission =
  | 'repo:edit'
  | 'monitor:edit'
  | 'review:trigger'
  | 'feedback:write'
  | 'memory:edit'
  | 'provider:edit'
  | 'engine:edit'
  | 'mcp:edit'
  | 'notification:edit'
  | 'log:manage'
  | 'user:manage';

export interface PermissionMeta {
  id: Permission;
  label: string;
  description: string;
  group: 'workspace' | 'models' | 'ops' | 'admin';
}

export const ALL_PERMISSIONS: PermissionMeta[] = [
  {
    id: 'repo:edit',
    label: '仓库编辑',
    description: '新建、编辑、删除代码库及初始化工作副本',
    group: 'workspace',
  },
  {
    id: 'monitor:edit',
    label: '监控规则编辑',
    description: '修改监控规则、启停监控及手动触发轮询',
    group: 'workspace',
  },
  {
    id: 'review:trigger',
    label: '手动触发评审',
    description: '手动触发单节点/区间评审、重试或取消任务',
    group: 'workspace',
  },
  {
    id: 'feedback:write',
    label: '缺陷反馈与分享',
    description: '标记缺陷（误报/已修复/不修复）及管理报告分享链接',
    group: 'workspace',
  },
  {
    id: 'memory:edit',
    label: '项目记忆编辑',
    description: '增删改项目记忆、重载 Markdown 与生成冷启动画像',
    group: 'workspace',
  },
  {
    id: 'provider:edit',
    label: 'AI 模型提供编辑',
    description: '增删改 AI 模型 Provider、设默认及连通性测试',
    group: 'models',
  },
  {
    id: 'engine:edit',
    label: '评审引擎修改',
    description: '增删改评审引擎及设置全局默认引擎',
    group: 'models',
  },
  {
    id: 'mcp:edit',
    label: 'MCP 服务编辑',
    description: '增删改 MCP 服务配置及连通性探测',
    group: 'models',
  },
  {
    id: 'notification:edit',
    label: '通知渠道编辑',
    description: '增删改通知渠道、启停、测试发送及触发规则',
    group: 'ops',
  },
  {
    id: 'log:manage',
    label: '运行日志管理',
    description: '查看、下载运行日志及调整日志级别',
    group: 'ops',
  },
  {
    id: 'user:manage',
    label: '用户与权限管理',
    description: '管理用户账号、角色权限、注册审批与审计日志',
    group: 'admin',
  },
];

export const PERMISSION_SET = new Set<string>(ALL_PERMISSIONS.map((p) => p.id));

export type RouteAccess = 'public' | 'authenticated' | 'super_admin' | Permission;

interface RouteRule {
  method: string; // 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | '*'
  pattern: RegExp;
  access: RouteAccess;
}

const ROUTE_RULES: RouteRule[] = [
  // --- Public routes ---
  { method: 'GET', pattern: /^\/api\/health$/, access: 'public' },
  { method: 'GET', pattern: /^\/api\/auth\/status$/, access: 'public' },
  { method: 'POST', pattern: /^\/api\/auth\/login$/, access: 'public' },
  { method: 'POST', pattern: /^\/api\/auth\/register$/, access: 'public' },
  { method: 'GET', pattern: /^\/api\/share\/[^/]+\/report$/, access: 'public' },
  { method: 'POST', pattern: /^\/api\/share\/[^/]+\/feedback$/, access: 'public' },

  // --- Self-account & auth session routes ---
  { method: 'POST', pattern: /^\/api\/auth\/logout$/, access: 'authenticated' },
  { method: 'POST', pattern: /^\/api\/auth\/password$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/me$/, access: 'authenticated' },
  { method: 'PUT', pattern: /^\/api\/me$/, access: 'authenticated' },
  { method: 'POST', pattern: /^\/api\/me\/password$/, access: 'authenticated' },

  // --- System deps ---
  { method: 'GET', pattern: /^\/api\/deps$/, access: 'authenticated' },
  { method: 'POST', pattern: /^\/api\/deps\/check$/, access: 'authenticated' },
  { method: 'POST', pattern: /^\/api\/deps\/[^/]+\/repair$/, access: 'engine:edit' },

  // --- Repos ---
  { method: 'GET', pattern: /^\/api\/repos$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/repos\/[^/]+$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/repos\/[^/]+\/init-status$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/repos\/[^/]+\/impact$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/repos\/[^/]+\/nodes$/, access: 'authenticated' },
  { method: 'POST', pattern: /^\/api\/repos$/, access: 'repo:edit' },
  { method: 'PUT', pattern: /^\/api\/repos\/[^/]+$/, access: 'repo:edit' },
  { method: 'DELETE', pattern: /^\/api\/repos\/[^/]+$/, access: 'repo:edit' },
  { method: 'POST', pattern: /^\/api\/repos\/[^/]+\/init$/, access: 'repo:edit' },

  // --- Review trigger & tasks ---
  { method: 'POST', pattern: /^\/api\/repos\/[^/]+\/review$/, access: 'review:trigger' },
  { method: 'POST', pattern: /^\/api\/repos\/[^/]+\/review-range$/, access: 'review:trigger' },
  { method: 'GET', pattern: /^\/api\/tasks$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/tasks\/[^/]+$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/tasks\/[^/]+\/report$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/tasks\/[^/]+\/mcp$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/tasks\/[^/]+\/memory$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/tasks\/[^/]+\/share$/, access: 'authenticated' },
  { method: 'POST', pattern: /^\/api\/tasks\/[^/]+\/cancel$/, access: 'review:trigger' },
  { method: 'POST', pattern: /^\/api\/tasks\/[^/]+\/retry$/, access: 'review:trigger' },
  { method: 'POST', pattern: /^\/api\/tasks\/[^/]+\/feedback$/, access: 'feedback:write' },
  { method: 'POST', pattern: /^\/api\/tasks\/[^/]+\/share$/, access: 'feedback:write' },
  { method: 'POST', pattern: /^\/api\/tasks\/[^/]+\/share\/rotate$/, access: 'feedback:write' },
  { method: 'DELETE', pattern: /^\/api\/tasks\/[^/]+\/share$/, access: 'feedback:write' },

  // --- Monitor ---
  { method: 'GET', pattern: /^\/api\/monitor\/rules$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/monitor\/rules\/[^/]+$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/monitor\/status$/, access: 'authenticated' },
  { method: 'PUT', pattern: /^\/api\/monitor\/rules\/[^/]+$/, access: 'monitor:edit' },
  { method: 'POST', pattern: /^\/api\/monitor\/rules\/[^/]+\/enable$/, access: 'monitor:edit' },
  { method: 'POST', pattern: /^\/api\/monitor\/rules\/[^/]+\/disable$/, access: 'monitor:edit' },
  { method: 'POST', pattern: /^\/api\/monitor\/rules\/[^/]+\/poll$/, access: 'monitor:edit' },

  // --- Project memory ---
  { method: 'GET', pattern: /^\/api\/repos\/[^/]+\/memory$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/repos\/[^/]+\/memory\/preview$/, access: 'authenticated' },
  { method: 'POST', pattern: /^\/api\/repos\/[^/]+\/memory$/, access: 'memory:edit' },
  { method: 'PUT', pattern: /^\/api\/repos\/[^/]+\/memory\/[^/]+$/, access: 'memory:edit' },
  { method: 'DELETE', pattern: /^\/api\/repos\/[^/]+\/memory\/[^/]+$/, access: 'memory:edit' },
  { method: 'POST', pattern: /^\/api\/repos\/[^/]+\/memory\/reload$/, access: 'memory:edit' },
  { method: 'POST', pattern: /^\/api\/repos\/[^/]+\/memory\/profile$/, access: 'memory:edit' },

  // --- Providers (GET readable for repo provider pool picker; API keys are masked) ---
  { method: 'GET', pattern: /^\/api\/providers$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/providers\/[^/]+$/, access: 'authenticated' },
  { method: 'POST', pattern: /^\/api\/providers$/, access: 'provider:edit' },
  { method: 'PUT', pattern: /^\/api\/providers\/[^/]+$/, access: 'provider:edit' },
  { method: 'DELETE', pattern: /^\/api\/providers\/[^/]+$/, access: 'provider:edit' },
  { method: 'POST', pattern: /^\/api\/providers\/[^/]+\/default$/, access: 'provider:edit' },
  { method: 'POST', pattern: /^\/api\/providers\/[^/]+\/test$/, access: 'provider:edit' },

  // --- Engines ---
  { method: 'GET', pattern: /^\/api\/engines$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/engines\/[^/]+\/capabilities$/, access: 'authenticated' },
  { method: 'POST', pattern: /^\/api\/engines$/, access: 'engine:edit' },
  { method: 'PUT', pattern: /^\/api\/engines\/[^/]+$/, access: 'engine:edit' },
  { method: 'DELETE', pattern: /^\/api\/engines\/[^/]+$/, access: 'engine:edit' },
  { method: 'POST', pattern: /^\/api\/engines\/[^/]+\/default$/, access: 'engine:edit' },

  // --- MCP servers ---
  { method: 'GET', pattern: /^\/api\/mcp-servers$/, access: 'authenticated' },
  { method: 'POST', pattern: /^\/api\/mcp-servers$/, access: 'mcp:edit' },
  { method: 'PUT', pattern: /^\/api\/mcp-servers\/[^/]+$/, access: 'mcp:edit' },
  { method: 'DELETE', pattern: /^\/api\/mcp-servers\/[^/]+$/, access: 'mcp:edit' },
  { method: 'POST', pattern: /^\/api\/mcp-servers\/[^/]+\/test$/, access: 'mcp:edit' },

  // --- Notifications ---
  { method: 'GET', pattern: /^\/api\/notifications\/channels$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/notifications\/channels\/[^/]+$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/notifications\/logs$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/notifications\/trigger$/, access: 'authenticated' },
  { method: 'GET', pattern: /^\/api\/notifications\/failure-policy$/, access: 'authenticated' },
  { method: 'POST', pattern: /^\/api\/notifications\/channels$/, access: 'notification:edit' },
  { method: 'PUT', pattern: /^\/api\/notifications\/channels\/[^/]+$/, access: 'notification:edit' },
  { method: 'DELETE', pattern: /^\/api\/notifications\/channels\/[^/]+$/, access: 'notification:edit' },
  { method: 'POST', pattern: /^\/api\/notifications\/channels\/[^/]+\/enable$/, access: 'notification:edit' },
  { method: 'POST', pattern: /^\/api\/notifications\/channels\/[^/]+\/disable$/, access: 'notification:edit' },
  { method: 'POST', pattern: /^\/api\/notifications\/channels\/[^/]+\/test$/, access: 'notification:edit' },
  { method: 'PUT', pattern: /^\/api\/notifications\/trigger$/, access: 'notification:edit' },
  { method: 'PUT', pattern: /^\/api\/notifications\/failure-policy$/, access: 'notification:edit' },

  // --- Logs ---
  { method: 'GET', pattern: /^\/api\/logs$/, access: 'log:manage' },
  { method: 'GET', pattern: /^\/api\/logs\/files$/, access: 'log:manage' },
  { method: 'GET', pattern: /^\/api\/logs\/files\/[^/]+$/, access: 'log:manage' },
  { method: 'POST', pattern: /^\/api\/logs\/level$/, access: 'log:manage' },

  // --- Admin (users, roles, registrations, audit logs) ---
  { method: '*', pattern: /^\/api\/admin(\/|$)/, access: 'user:manage' },
];

export function requiredAccessFor(method: string, urlPath: string): RouteAccess {
  const m = method.toUpperCase();
  const path = urlPath.split('?')[0];
  for (const rule of ROUTE_RULES) {
    if ((rule.method === '*' || rule.method === m) && rule.pattern.test(path)) {
      return rule.access;
    }
  }
  return 'super_admin';
}

export function normalizePermissions(raw: unknown): Permission[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<Permission>();
  for (const item of raw) {
    if (typeof item === 'string' && PERMISSION_SET.has(item)) {
      seen.add(item as Permission);
    }
  }
  return Array.from(seen);
}

export function parsePermissionsJson(text: string | null | undefined): Permission[] {
  if (!text) return [];
  try {
    return normalizePermissions(JSON.parse(text));
  } catch {
    return [];
  }
}
