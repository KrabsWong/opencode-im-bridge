# Bridge as a Service (BaaS) 架构设计 - Plugin 适配版

## 背景与约束

- **当前项目**：以 OpenCode plugin 形式运行
- **核心约束**：**不能修改 OpenCode 核心代码**
- **目标**：在 plugin 限制下实现多 OpenCode 实例的统一管理

## 方案对比

| 方案 | 原理 | 复杂度 | 推荐度 |
|------|------|--------|--------|
| **A. Plugin-as-Client** | Plugin 主动连接 Bridge Hub | 中 | 推荐 |
| **B. HTTP Registration** | Plugin 注册 HTTP 端点到 Hub | 中 | 可选 |
| **C. Telegram Bot 多路由** | 多个 Plugin 共享一个 Bot | 低 | 简单场景 |

---

## 推荐方案：A. Plugin-as-Client 模式

### 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    Bridge Hub Service                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │  Telegram   │  │   Slack     │  │  WebSocket Server       │ │
│  │  Bot        │  │   Bot       │  │  (等待 Plugin 连接)      │ │
│  └──────┬──────┘  └──────┬──────┘  └────────────┬────────────┘ │
│         │                │                       │              │
│         └────────────────┴───────────────────────┘              │
│                              │                                  │
│                    ┌─────────┴──────────┐                      │
│                    │   Message Router   │                      │
│                    │  (按 workspace 路由) │                     │
│                    └─────────┬──────────┘                      │
└──────────────────────────────┼──────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
        WebSocket            WebSocket        WebSocket
        连接                 连接              连接
              │                │                │
    ┌─────────┴──┐    ┌────────┴────┐  ┌───────┴──────┐
    │  Plugin    │    │   Plugin    │  │    Plugin    │
    │ (Project A)│    │ (Project B) │  │  (Project C) │
    └─────┬──────┘    └──────┬──────┘  └──────┬───────┘
          │                  │                │
    ┌─────┴──────┐    ┌──────┴──────┐  ┌──────┴──────┐
    │  OpenCode  │    │  OpenCode   │  │  OpenCode   │
    │  (A目录)   │    │  (B目录)    │  │  (C目录)    │
    └────────────┘    └─────────────┘  └─────────────┘
```

### 核心流程

1. **启动时**：Plugin 作为 WebSocket 客户端连接到 Bridge Hub
2. **注册时**：Plugin 发送 workspace、instanceId 等信息
3. **消息时**：Bridge Hub 根据用户选择的 workspace 路由到对应 Plugin
4. **响应时**：Plugin 通过 WebSocket 返回响应，Bridge Hub 转发到 Telegram

---

## 详细设计

### 1. Bridge Hub Service 结构

```
bridge-hub/
├── src/
│   ├── server/
│   │   ├── websocket-server.ts    # 接受 Plugin 连接
│   │   ├── http-api.ts            # HTTP API (健康检查等)
│   │   └── instance-registry.ts   # 实例注册表
│   ├── adapters/
│   │   ├── telegram.ts            # Telegram Bot 适配器
│   │   └── slack.ts               # (预留)
│   ├── router/
│   │   └── message-router.ts      # 消息路由核心
│   ├── types/
│   │   └── index.ts
│   └── index.ts
├── package.json
└── docker-compose.yml
```

### 2. Plugin 端改造

在现有 plugin 基础上增加 Hub Client 模式：

```typescript
// src/hub-client.ts (新增)
export class HubClient {
  private socket: WebSocket
  private config: HubConfig
  private messageQueue: any[] = []
  
  async connect() {
    this.socket = new WebSocket(this.config.hubUrl)
    
    this.socket.onopen = () => {
      // 注册自己
      this.socket.send(JSON.stringify({
        type: 'register',
        instanceId: this.config.instanceId || process.cwd(),
        workspace: process.cwd(),
        authToken: this.config.authToken,
        capabilities: ['questions', 'permissions', 'directMessaging']
      }))
    }
    
    this.socket.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      this.handleHubMessage(msg)
    }
  }
  
  private async handleHubMessage(msg: HubMessage) {
    switch (msg.type) {
      case 'prompt':
        // 调用现有 IMBridge 的功能
        const result = await this.bridge.handleDirectMessage(msg.text, msg.userId)
        this.socket.send(JSON.stringify({
          type: 'response',
          requestId: msg.requestId,
          data: result
        }))
        break
        
      case 'command':
        // 执行命令如 /sessions, /use 等
        const cmdResult = await this.bridge.executeCommand(msg.command, msg.args)
        this.socket.send(JSON.stringify({
          type: 'response',
          requestId: msg.requestId,
          data: cmdResult
        }))
        break
    }
  }
}
```

### 3. Plugin 配置变更

```json
{
  "plugin": [
    ["opencode-im-bridge", {
      "mode": "hub-client",
      "hubConfig": {
        "hubUrl": "ws://localhost:3001",
        "instanceId": "my-project",
        "authToken": "xxx"
      }
    }]
  ]
}
```

### 4. 关键代码：Plugin 入口改造

```typescript
const IMBridgePlugin: Plugin = async (input, options: IMBridgeOptions) => {
  // 根据模式选择工作方式
  if (options.mode === 'hub-client') {
    // Hub 模式：Plugin 作为客户端连接到 Bridge Hub
    return setupHubClientMode(input, options.hubConfig)
  } else {
    // Standalone 模式：保持现有功能（直接连接 Telegram）
    return setupStandaloneMode(input, options)
  }
}

// Hub 客户端模式
async function setupHubClientMode(input: PluginInput, hubConfig: HubConfig): Promise<Hooks> {
  const hubClient = new HubClient(hubConfig, input)
  await hubClient.connect()
  
  return {
    event: async ({ event }) => {
      // 转发 OpenCode 事件到 Hub
      switch (event.type) {
        case "question.asked":
          await hubClient.sendEvent('question.asked', event.properties)
          break
        case "permission.asked":
          await hubClient.sendEvent('permission.asked', event.properties)
          break
      }
    }
  }
}
```

### 5. Bridge Hub 核心：实例注册表

```typescript
// bridge-hub/src/server/instance-registry.ts
interface ConnectedInstance {
  id: string
  workspace: string
  socket: WebSocket
  status: 'connected' | 'busy' | 'disconnected'
  lastPing: number
  capabilities: string[]
  userMappings: Map<string, string> // userId -> sessionId
}

class InstanceRegistry {
  private instances: Map<string, ConnectedInstance> = new Map()
  private userContext: Map<string, UserContext> = new Map() // tgUserId -> context
  
  // 注册新实例（Plugin 连接时调用）
  register(instance: ConnectedInstance) {
    this.instances.set(instance.id, instance)
    console.log(`Instance registered: ${instance.id} (${instance.workspace})`)
  }
  
  // 获取用户当前选中的实例
  getUserInstance(userId: string): ConnectedInstance | undefined {
    const context = this.userContext.get(userId)
    if (!context?.selectedInstanceId) return undefined
    return this.instances.get(context.selectedInstanceId)
  }
  
  // 获取所有实例列表（用于 /instances 命令）
  getAllInstances(): Array<{ id: string, workspace: string, status: string }> {
    return Array.from(this.instances.values()).map(i => ({
      id: i.id,
      workspace: i.workspace,
      status: i.status
    }))
  }
  
  // 向指定实例发送消息并等待响应
  async sendToInstance(instanceId: string, message: any): Promise<any> {
    const instance = this.instances.get(instanceId)
    if (!instance) throw new Error(`Instance ${instanceId} not found`)
    
    return new Promise((resolve, reject) => {
      const requestId = generateId()
      
      const handler = (event: MessageEvent) => {
        const response = JSON.parse(event.data)
        if (response.requestId === requestId) {
          instance.socket.removeEventListener('message', handler)
          resolve(response.data)
        }
      }
      
      instance.socket.addEventListener('message', handler)
      instance.socket.send(JSON.stringify({
        type: 'request',
        requestId,
        data: message
      }))
      
      setTimeout(() => {
        instance.socket.removeEventListener('message', handler)
        reject(new Error('Timeout'))
      }, 30000)
    })
  }
}
```

### 6. Bridge Hub 核心：消息路由

```typescript
// bridge-hub/src/router/message-router.ts
class MessageRouter {
  constructor(
    private instanceRegistry: InstanceRegistry,
    private telegramAdapter: TelegramAdapter
  ) {}
  
  async routeTelegramMessage(tgMessage: TelegramMessage) {
    const text = tgMessage.text.trim()
    const userId = tgMessage.from.id.toString()
    
    // 解析命令
    if (text.startsWith('/')) {
      await this.handleCommand(text, userId, tgMessage)
      return
    }
    
    // 普通消息：转发到用户当前选中的实例
    const instance = this.instanceRegistry.getUserInstance(userId)
    if (!instance) {
      await this.telegramAdapter.sendMessage({
        chatId: tgMessage.chat.id,
        text: '请先选择实例：/instances 查看可用实例'
      })
      return
    }
    
    // 转发到对应 Plugin
    const response = await this.instanceRegistry.sendToInstance(
      instance.id,
      {
        type: 'prompt',
        text: text,
        userId: userId,
        chatId: tgMessage.chat.id
      }
    )
    
    // 将响应发回 Telegram
    await this.telegramAdapter.sendMessage({
      chatId: tgMessage.chat.id,
      text: response.text,
      parseMode: 'HTML'
    })
  }
  
  private async handleCommand(text: string, userId: string, tgMessage: TelegramMessage) {
    const [command, ...args] = text.split(' ')
    
    switch (command) {
      case '/instances':
        const instances = this.instanceRegistry.getAllInstances()
        let msg = '📂 所有实例\n\n'
        instances.forEach(i => {
          msg += `${i.id}\n  目录: ${i.workspace}\n  状态: ${i.status}\n\n`
        })
        await this.telegramAdapter.sendMessage({
          chatId: tgMessage.chat.id,
          text: msg
        })
        break
        
      case '/use':
        const instanceId = args[0]
        this.instanceRegistry.setUserInstance(userId, instanceId)
        await this.telegramAdapter.sendMessage({
          chatId: tgMessage.chat.id,
          text: `已切换到实例: ${instanceId}`
        })
        break
    }
  }
}
```

---

## 部署方案

### Bridge Hub 独立部署

```yaml
# docker-compose.yml
version: '3.8'

services:
  bridge-hub:
    build: ./bridge-hub
    ports:
      - "3001:3001"
    environment:
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - PORT=3001
      - AUTH_TOKEN=${AUTH_TOKEN}
    restart: unless-stopped
```

### 各项目 Plugin 配置

```json
{
  "plugin": [
    ["opencode-im-bridge", {
      "mode": "hub-client",
      "hubConfig": {
        "hubUrl": "ws://your-server:3001",
        "instanceId": "project-a",
        "authToken": "shared-secret-token"
      }
    }]
  ]
}
```

---

## 工作流程示例

### 场景：用户通过 Telegram 与多个项目交互

```
用户: /instances
Bot:
📂 所有实例

project-a
  目录: /Users/alice/project-a
  状态: connected

project-b
  目录: /Users/alice/project-b
  状态: connected

用户: /use project-a
Bot: 已切换到实例: project-a

用户: 帮我优化这段代码
Bot: [转发到 project-a 的 OpenCode 实例]
     [project-a 处理完成]
     已优化，主要改进：...

用户: /use project-b
Bot: 已切换到实例: project-b

用户: 现在帮我看看这个 bug
Bot: [转发到 project-b 的 OpenCode 实例]
```

---

## 优势与局限

### 优势

1. **零侵入**：不需要修改 OpenCode 代码
2. **向后兼容**：Standalone 模式继续可用
3. **集中管理**：一个 Telegram Bot 管理多个项目
4. **实时通信**：WebSocket 双向通信
5. **灵活部署**：Hub 可独立部署在服务器上

### 局限

1. **网络依赖**：Plugin 需要能连接到 Hub
2. **单点故障**：Hub 宕机会影响所有实例
3. **状态同步**：需要考虑断线重连机制

---

## 实现路线图

### Phase 1: 基础 Hub (1周)
- [ ] Bridge Hub WebSocket 服务端
- [ ] 实例注册表
- [ ] 基础消息转发

### Phase 2: Plugin 改造 (1周)
- [ ] HubClient 模块
- [ ] 双模式支持 (standalone / hub-client)
- [ ] 事件转发机制

### Phase 3: 完整功能 (1周)
- [ ] Telegram Bot 命令适配
- [ ] 用户状态管理
- [ ] 断线重连

### Phase 4: 优化 (可选)
- [ ] 多用户支持
- [ ] 负载均衡
- [ ] 监控和日志

---

## 与原方案的关键区别

| 方面 | 原 BaaS 方案 | Plugin 适配方案 |
|------|-------------|----------------|
| 连接方向 | OpenCode 连接 Bridge | Plugin 连接 Bridge Hub |
| 侵入性 | 需要修改 OpenCode | 零侵入 |
| 实现位置 | OpenCode 核心 + Bridge Service | Plugin + Bridge Hub |
| 部署方式 | OpenCode 实例需改造 | 独立 Hub + 配置即可 |
| 兼容性 | 需要新版本 OpenCode | 现有 OpenCode 即可 |
