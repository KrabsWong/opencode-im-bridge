# OpenCode IM Bridge

通用的 IM 桥接插件，让 OpenCode 与各种即时通讯平台双向通信。

## 功能特性

- **双向通信**: 从 IM 接收问题、发送回复，向 OpenCode 发送消息
- **权限审批**: 在 IM 中审批 OpenCode 的权限请求
- **状态查询**: 随时查询会话状态和进度
- **多平台支持**: Telegram、Slack、Discord（可扩展）
- **灵活配置**: 自定义消息模板、权限控制、功能开关

## 支持的 IM 平台

| 平台 | 状态 | 特性 |
|------|------|------|
| Telegram | ✅ 可用 | 按钮、Markdown、Webhook/Long Polling |
| Slack | 🚧 计划中 | Block Kit、Slash Commands |
| Discord | 🚧 计划中 | 内嵌按钮、Rich Embed |

## 快速开始

### 1. 安装插件

```bash
# 在 opencode 项目中
npm install opencode-im-bridge

# 或在 .opencode 目录
opencode plugin add opencode-im-bridge
```

### 2. 创建 Telegram Bot

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot` 创建新机器人
3. 获取 Bot Token
4. 发送 `/start` 给自己创建的机器人
5. 获取你的 Chat ID（可以通过 [@userinfobot](https://t.me/userinfobot)）

### 3. 配置插件

在 `.opencode/config.json` 中添加：

```json
{
  "plugin": [
    ["opencode-im-bridge", {
      "platform": "telegram",
      "platformConfig": {
        "botToken": "YOUR_BOT_TOKEN",
        "chatId": "YOUR_CHAT_ID"
      },
      "bridgeConfig": {
        "adminUsers": ["YOUR_USER_ID"],
        "features": {
          "questions": true,
          "permissions": true,
          "statusQuery": true,
          "directMessaging": true,
          "autoStatus": true
        },
        "sessionStrategy": "latest"
      }
    }]
  ]
}
```

### 4. 启动 OpenCode

```bash
opencode
```

现在当 OpenCode 需要确认时，你会在 Telegram 收到消息！

## 配置详解

### 平台配置

#### Telegram

```typescript
{
  botToken: string      // Bot Token from @BotFather
  chatId: string        // Target chat ID (can be group chat)
  webhookUrl?: string   // Optional: webhook URL
  webhookPort?: number  // Optional: webhook server port
}
```

**Webhook vs Long Polling**
- 开发环境：默认使用 Long Polling，无需配置
- 生产环境：使用 Webhook 更高效
  ```json
  {
    "webhookUrl": "https://your-server.com/webhook",
    "webhookPort": 3000
  }
  ```

### 桥接配置

```typescript
{
  // 管理员用户 ID 列表（为空表示允许所有）
  adminUsers?: string[]
  
  // 允许的聊天 ID（为空表示允许所有）
  allowedChats?: string[]
  
  // 自定义消息模板
  templates?: {
    question?: (info: QuestionInfo) => string
    permission?: (info: PermissionInfo) => string
    status?: (sessions: SessionInfo[]) => string
    welcome?: () => string
    help?: () => string
  }
  
  // 功能开关
  features?: {
    questions?: boolean      // 启用问题通知
    permissions?: boolean    // 启用权限请求
    statusQuery?: boolean    // 启用状态查询
    directMessaging?: boolean // 启用直接消息
    autoStatus?: boolean     // 自动回复状态
  }
  
  // 会话选择策略
  sessionStrategy?: "latest" | "active" | "manual"
}
```

## Telegram 命令

在 Telegram 中使用以下命令：

| 命令 | 描述 |
|------|------|
| `/start` | 显示欢迎消息 |
| `/help` | 显示帮助 |
| `/status` | 查看当前会话状态 |
| `/sessions` | 列出所有会话 |
| `/use <id>` | 选择特定会话 |
| `/ask <message>` | 向当前会话发送消息 |
| `/pending` | 查看待处理的请求 |

## 工作流程

### 场景 1: AI 需要确认方案

```
OpenCode: 生成 Plan
    ↓
需要用户选择方案 A/B/C
    ↓
发送 Telegram 消息（带按钮）
    ↓
用户点击按钮
    ↓
Telegram → OpenCode (question.reply)
    ↓
OpenCode 继续执行
```

### 场景 2: 权限审批

```
OpenCode: 要编辑文件
    ↓
需要 edit 权限
    ↓
发送 Telegram 消息（允许/拒绝按钮）
    ↓
用户选择 "允许一次"
    ↓
Telegram → OpenCode (permission.reply)
    ↓
OpenCode 执行编辑
```

### 场景 3: 主动查询和发送

```
用户: /status
    ↓
Telegram → OpenCode (session.list)
    ↓
返回会话状态

用户: /ask 现在进度如何？
    ↓
Telegram → OpenCode (session.prompt)
    ↓
消息加入会话上下文
    ↓
AI 在下次回复时回答
```

## 自定义适配器

轻松添加新的 IM 平台支持：

```typescript
import type { IMAdapter, IMMessage, IMCallbackQuery, IMOutgoingMessage } from "opencode-im-bridge"

export class MyCustomAdapter implements IMAdapter {
  readonly name = "myplatform"
  readonly version = "1.0.0"
  
  async initialize(config: Record<string, unknown>): Promise<void> {
    // 初始化连接
  }
  
  async sendMessage(message: IMOutgoingMessage): Promise<{ messageId: string }> {
    // 发送消息到 IM 平台
  }
  
  onMessage(handler: (message: IMMessage) => void): void {
    // 设置消息处理器
  }
  
  onCallback(handler: (callback: IMCallbackQuery) => void): void {
    // 设置回调处理器
  }
  
  async start(): Promise<void> {
    // 开始接收消息
  }
  
  async stop(): Promise<void> {
    // 停止接收
  }
}

// 在配置中使用
{
  "platform": "custom",
  "customAdapter": "./my-custom-adapter.js",
  "platformConfig": { ... }
}
```

## 高级用法

### 自定义消息模板

```json
{
  "templates": {
    "question": "(info) => `🤔 **${info.questions[0].header}**\\n\\n${info.questions[0].question}`",
    "status": "(sessions) => sessions.map(s => `📊 ${s.id}: ${s.completedCount}/${s.todoCount}`).join('\\n')"
  }
}
```

### 多用户权限控制

```json
{
  "adminUsers": ["123456789", "987654321"],
  "allowedChats": ["-1001234567890"]
}
```

### 功能开关

```json
{
  "features": {
    "questions": true,        // 接收问题通知
    "permissions": true,      // 接收权限请求
    "statusQuery": true,      // 允许查询状态
    "directMessaging": true,  // 允许直接发消息
    "autoStatus": false       // 关闭自动状态回复
  }
}
```

## 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    IM Platform                              │
│              (Telegram / Slack / Discord)                    │
└───────────────────┬─────────────────────────────────────────┘
                    │ HTTP/WebSocket
                    ▼
┌─────────────────────────────────────────────────────────────┐
│              Platform Adapter                               │
│     (TelegramAdapter / SlackAdapter / ...)                  │
└───────────────────┬─────────────────────────────────────────┘
                    │ Unified Interface
                    ▼
┌─────────────────────────────────────────────────────────────┐
│                   IM Bridge Core                            │
│     • Message routing                                       │
│     • State management                                      │
│     • Command handling                                      │
│     • Event translation                                     │
└───────────────────┬─────────────────────────────────────────┘
                    │ OpenCode Plugin API
                    ▼
┌─────────────────────────────────────────────────────────────┐
│                   OpenCode Core                             │
│     • Question Service                                      │
│     • Permission Service                                    │
│     • Session Management                                    │
│     • Event Bus                                             │
└─────────────────────────────────────────────────────────────┘
```

## 开发计划

- [x] Core bridge architecture
- [x] Telegram adapter
- [ ] Slack adapter
- [ ] Discord adapter
- [ ] Message queue persistence
- [ ] Multi-session support
- [ ] Rate limiting
- [ ] Message threading

## 贡献指南

欢迎贡献新的适配器！请参考：

1. 实现 `IMAdapter` 接口
2. 放在 `src/adapters/` 目录
3. 更新适配器注册表
4. 添加文档和示例

## License

MIT
