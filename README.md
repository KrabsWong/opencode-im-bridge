# OpenCode IM Bridge

通用的 IM 桥接插件，让 OpenCode 与各种即时通讯平台双向通信。

## 功能特性

- **双向通信**: 从 IM 接收问题、发送回复，向 OpenCode 发送消息
- **权限审批**: 在 IM 中审批 OpenCode 的权限请求
- **会话管理**: 查看活动会话、切换会话、向指定会话发送消息
- **AI 生成标题**: 一键让 AI 分析对话内容并自动生成合适的会话标题
- **远程控制**: 通过 Telegram 按钮执行 OpenCode 内部命令（compact、interrupt、新建会话等）
- **Markdown 渲染**: 自动将 Markdown 转换为 Telegram HTML，支持表格、代码块等
- **多平台支持**: Telegram、Slack、Discord（可扩展）
- **灵活配置**: 自定义消息模板、权限控制、功能开关

## 支持的 IM 平台

| 平台 | 状态 | 特性 |
|------|------|------|
| Telegram | ✅ 可用 | 按钮、Markdown→HTML 转换、表格支持、Webhook/Long Polling |
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
          "directMessaging": true
        }
      }
    }]
  ]
}
```

**配置说明：**

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `botToken` | 从 @BotFather 获取的 Bot Token | 必填 |
| `chatId` | 你的 Telegram 用户 ID（可通过 @userinfobot 获取） | 必填 |
| `adminUsers` | 允许使用 Bot 命令的用户 ID 列表，为空表示允许所有用户 | `[]` |
| `allowedChats` | 允许接收消息的聊天/群组 ID 列表，为空表示允许所有聊天 | `[]` |
| `features.questions` | 接收 AI 问题通知（当 AI 需要确认时推送消息） | `true` |
| `features.permissions` | 接收权限请求通知（当 AI 需要权限时推送消息） | `true` |
| `features.directMessaging` | 允许通过 /ask 命令向会话发送消息 | `true` |

**Webhook 配置（可选）：**

默认使用 Long Polling，如需使用 Webhook（生产环境推荐）：

```json
{
  "platformConfig": {
    "botToken": "YOUR_BOT_TOKEN",
    "chatId": "YOUR_CHAT_ID",
    "webhookUrl": "https://your-server.com/webhook",
    "webhookPort": 3000
  }
}
```

### 4. 启动 OpenCode

```bash
opencode
```

现在当 OpenCode 需要确认时，你会在 Telegram 收到消息！

**会话自动选择机制：**
当你使用 `/ask` 命令但没有通过 `/use` 选择会话时，系统会自动使用**最新的活动会话**（按更新时间排序的第一个会话）。建议先使用 `/sessions` 查看活动会话，然后使用 `/use <sessionId>` 选择特定会话。

## Telegram 命令

在 Telegram 中使用以下命令：

| 命令 | 描述 |
|------|------|
| `/help` | 显示帮助信息 |
| `/sessions` | 列出活动会话（busy/retry/1h内） |
| `/current` | 查看当前选中的会话 |
| `/use <id>` | 选择特定会话 |
| `/ask <message>` | 向当前会话发送消息 |
| `/cmd` | 显示远程控制面板（compact/interrupt/新建会话/生成标题） |

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
用户: /sessions
    ↓
Telegram → OpenCode (session.list)
    ↓
返回活动会话列表（带选择按钮）

用户: /use <sessionId>
    ↓
选择特定会话

用户: /ask 现在进度如何？
    ↓
Telegram → OpenCode (session.prompt)
    ↓
消息加入会话上下文
    ↓
AI 在下次回复时回答
```

### 场景 4: 远程控制与标题生成

```
用户: /cmd
    ↓
显示控制面板按钮
    ↓
用户点击「生成标题」
    ↓
向当前会话发送 system prompt
    ↓
AI 分析对话内容生成标题
    ↓
调用 PATCH /session/{id} 更新标题
    ↓
Telegram 回复：✅ 标题已更新为「xxx」

其他控制按钮：
- session_compact: 压缩会话历史
- session_new: 新建会话
- session_interrupt: 中断当前任务
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
```

## 高级配置

### 自定义消息模板

```json
{
  "templates": {
    "question": "(info) => `🤔 **${info.questions[0].header}**\\n\\n${info.questions[0].question}`",
    "permission": "(info) => `🔒 **权限请求**\\n\\n工具: ${info.permission}`",
    "help": "() => `欢迎使用 IM Bridge`"
  }
}
```

**说明：**
- `question`: 问题通知模板，参数 `info` 包含问题详情
- `permission`: 权限请求模板，参数 `info` 包含权限信息
- `help`: 帮助信息模板

### 多用户权限控制

```json
{
  "adminUsers": ["123456789", "987654321"],
  "allowedChats": ["-1001234567890"]
}
```

**说明：**
- `adminUsers`: 允许使用 Bot 命令的用户 ID 列表
- `allowedChats`: 允许接收消息的聊天/群组 ID 列表，群组 ID 通常以 `-100` 开头

## 架构设计

```mermaid
flowchart TB
    subgraph IM["IM Platform"]
        TG["Telegram Bot"]
        SL["Slack (计划中)"]
        DC["Discord (计划中)"]
    end

    subgraph Adapter["平台适配器层"]
        TA["TelegramAdapter"]
    end

    subgraph Core["IM Bridge 核心"]
        MR["消息路由"]
        SM["状态管理"]
        CH["命令处理"]
        ET["事件转换"]
    end

    subgraph OC["OpenCode 核心"]
        QS["问题服务"]
        PS["权限服务"]
        SesM["会话管理"]
    end

    TG <-->|"HTTP API / Webhook"| TA
    SL -.->|"计划中"| Adapter
    DC -.->|"计划中"| Adapter

    TA <-->|"统一接口"| Core

    MR <-->|"插件 API"| OC
    SM -.->|"管理"| MR
    CH -.->|"处理"| MR
    ET -.->|"转换"| MR

    style IM fill:#e1f5fe
    style Adapter fill:#fff3e0
    style Core fill:#e8f5e9
    style OC fill:#fce4ec
```

## 开发计划

- [x] Core bridge architecture
- [x] Telegram adapter
- [x] Markdown to Telegram HTML conversion
- [x] Markdown table support
- [x] AI 自动生成会话标题
- [x] 远程控制面板 (/cmd)
- [ ] Slack adapter
- [ ] Discord adapter
- [ ] Message queue persistence
- [ ] Rate limiting

## 贡献指南

欢迎贡献新的适配器！请参考：

1. 实现 `IMAdapter` 接口
2. 放在 `src/adapters/` 目录
3. 更新适配器注册表
4. 添加文档和示例

## License

MIT
