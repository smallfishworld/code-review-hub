# 推送网关接入契约（Notification Gateway Contract）

code-review-hub 的通知渠道对任意 IM / 消息平台保持平台无关：hub 只会向你配置的
webhook URL 发送**一个渲染好的 JSON POST**，仅此而已。任何「能接收这样一个 POST
并把消息投递到真实平台」的服务，我们都称之为**推送网关（gateway）**。

hub 内部不包含任何具体平台的协议代码。接入一个新平台的全部工作是：

1. 部署/编写一个符合本契约的网关服务（或使用平台官方的直连 API）；
2. 在 hub「通知渠道」页新建一个 **聊天机器人（chat）渠道**，填入网关地址与鉴权头；
3. 配置一个 JSON 模板，把 hub 的占位符映射成网关需要的字段。

## 1. hub → gateway 请求

```
POST {webhookUrl}
Content-Type: application/json
{自定义鉴权头，如 X-Gateway-Key: <secret>}

<渲染后的模板 JSON>
```

- **鉴权**：渠道配置的 headers 全部随请求发出。密钥值属于敏感信息，加密存储于
  hub 服务端，API 返回时以 `********` 掩码。
- **模板渲染**：模板是 JSON 文本，hub 渲染 `{{placeholder}}` 占位符后整体作为
  请求体 POST。占位符如下：

| 占位符 | 含义 | 示例 |
| --- | --- | --- |
| `{{repo}}` | 仓库标识（SVN 路径或 git URL） | `svn://x/srv/main` |
| `{{repo_url}}` | 仓库地址（配置的 SVN 路径 / git URL） | `svn://x/srv/main` |
| `{{node}}` | 评审的版本号/commit | `12345` |
| `{{author}}` | 上库人员标识 | `zhangsan5` |
| `{{commit_message}}` | 上库日志（commit message，入队时快照） | `修复登录超时` |
| `{{commit_date}}` | 上库时间（本地时区，`YYYY-MM-DD HH:mm`） | `2026-11-27 16:59` |
| `{{status}}` | 评审状态 | `成功` / `失败` |
| `{{summary}}` | 评审摘要（失败时为失败原因） | ... |
| `{{report_url}}` | 报告页面链接 | `http://hub/tasks/42` |

未知占位符原样保留（方便发现模板拼写错误）。

- **响应语义**：HTTP 2xx 即视为受理成功；网关应当**异步投递**（立即 202 更佳），
  消息队列、限频串行、对平台的重试都由网关负责。非 2xx 时 hub 会按通知机制做
  有界重试（默认 3 次）。

## 2. 收件人路由

hub 不做任何账号映射。`{{author}}` 的值（对 SVN 即上库人员名）由**模板**填进
网关的收件人字段；uid 归一化（大小写等）与平台账号体系对接由网关完成。

## 3. 平台接入形态参考

| 平台 | 形态 | 是否需要自建网关 |
| --- | --- | --- |
| Telegram Bot | 官方 HTTP API，token 在 URL | 否，直接配 webhookUrl |
| 企业微信群机器人 | 官方 webhook | 否 |
| 飞书自建应用 | token 管理 + 消息 API | 是（token 逻辑放网关） |
| 企业自建 IM（OAuth token + 平台 API） | 自建网关 | 是 |
| 个人微信 / QQ（OneBot 等） | 社区网关协议 | 使用现成网关 |

## 4. 示例：接入一个自定义网关

渠道配置：

- webhookUrl: `http://push-gateway:3100/api/send`
- headers: `X-Gateway-Key: <secret>`

模板（网关需要 receiverUid/title/body/url 四个字段）：
占位符写在 JSON 字符串值的双引号内。提交说明和评审摘要中的引号、反斜杠及换行由系统转义，无需手动处理。

```json
{
  "receiverUid": "{{author}}",
  "title": "代码评审 {{repo}} {{node}} {{status}}",
  "body": "上库人员：{{author}}\n摘要：{{summary}}",
  "url": "{{report_url}}"
}
```

网关只需实现：收到 POST → 校验鉴权头 → 入队投递 → 返回 2xx。
