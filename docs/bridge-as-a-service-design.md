# Bridge as a Service (BaaS) 架构设计

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                     Bridge Service                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  Telegram   │  │   Slack     │  │    Discord          │ │
│  │  Adapter    │  │  Adapter    │  │   Adapter           │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘ │
│         │                │                    │            │
│         └────────────────┴────────────────────┘            │
│                          │                                  │
│                    ┌─────┴─────┐                           │
│                    │  Message  │                           │
│                    │  Router   │                           │
│                    └─────┬─────┘                           │
│                          │                                  │
│         ┌────────────────┼────────────────┐                │
│         │                │                │                │
│    ┌────┴────┐     ┌────┴────┐     ┌────┴────┐          │
│    │ OpenCode│     │ OpenCode│     │ OpenCode│          │
│    │ Client  │     │ Client  │     │ Client  │          │
│    │ (Dir A) │     │ (Dir B) │     │ (Dir C) │          │
│    └────┬────┘     └────┬────┘     └────┬────┘          │
└─────────┼──────────────┼──────────────┼──────────────────┘
          │              │              │
    ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐
    │ opencode  │  │ opencode  │  │ opencode  │
    │  (A目录)  │  │  (B目录)  │  │  (C目录)  │
    └───────────┘  └───────────┘  └───────────┘
```

## 2. 核心设计

### 2.1 通信方式

Bridge Service 和 OpenCode 实例之间使用 **WebSocket** 或 **HTTP API** 通信：

**方案 A: WebSocket (推荐)**
- 实时双向通信
- OpenCode 实例启动时主动连接到 Bridge Service
- 支持事件推送（questions, permissions 等）

**方案 B: HTTP API**
- OpenCode 实例暴露 HTTP API
- Bridge Service 轮询或调用
- 更简单但实时性较差

### 2.2 服务发现

每个 OpenCode 实例启动时注册到 Bridge Service：

```typescript
// OpenCode 实例启动时
const bridgeClient = new BridgeClient({
  serviceUrl: 'ws://localhost:3001',
  instanceId: 'project-a',  // 实例标识
  workspace: '/path/to/project-a',  // 工作目录
  authToken: 'xxx'
})

await bridgeClient.connect()
```

## 3. 实现方案

### 3.1 Bridge Service 结构

```
src/
├── server/
│   ├── websocket-server.ts    # WebSocket 服务端
│   ├── http-api.ts            # HTTP API 端点
│   └── instance-manager.ts    # 实例管理器
├── adapters/
│   ├── telegram.ts
│   ├── slack.ts
│   └── discord.ts
├── router/
│   ├── message-router.ts      # 消息路由
│   └── session-router.ts      # 会话路由
├── types/
│   └── index.ts
└── index.ts
```

### 3.2 核心代码设计

#### InstanceManager - 管理多个 OpenCode 实例

```typescript
interface OpenCodeInstance {
  id: string
  workspace: string
  socket: WebSocket
  status: 'connected' | 'disconnected' | 'busy'
  lastPing: number
  capabilities: string[]
}

class InstanceManager {
  private instances: Map<string, OpenCodeInstance> = new Map()
  
  // 注册新实例
  register(instance: OpenCodeInstance) {
    this.instances.set(instance.id, instance)
  }
  
  // 获取实例
  getInstance(id: string): OpenCodeInstance | undefined {
    return this.instances.get(id)
  }
  
  // 获取所有实例
  getAllInstances(): OpenCodeInstance[] {
    return Array.from(this.instances.values())
  }
  
  // 按工作目录查找实例
  findByWorkspace(workspace: string): OpenCodeInstance | undefined {
    return this.getAllInstances().find(i => i.workspace === workspace)
  }
  
  // 获取所有会话列表（聚合）
  async getAllSessions(): Promise<Session[]> {
    const allSessions: Session[] = []
    for (const instance of this.getAllInstances()) {
      const sessions = await this.queryInstanceSessions(instance.id)
      allSessions.push(...sessions.map(s => ({
        ...s,
        instanceId: instance.id,
        workspace: instance.workspace
      })))
    }
    return allSessions
  }
  
  // 向指定实例发送消息
  async sendToInstance(instanceId: string, message: any): Promise<any> {
    const instance = this.getInstance(instanceId)
    if (!instance) throw new Error(`Instance ${instanceId} not found`)
    
    return new Promise((resolve, reject) => {
      const requestId = generateId()
      
      // 发送请求
      instance.socket.send(JSON.stringify({
        type: 'request',
        requestId,
        data: message
      }))
      
      // 等待响应
      const handler = (event: MessageEvent) => {
        const response = JSON.parse(event.data)
        if (response.requestId === requestId) {
          instance.socket.removeEventListener('message', handler)
          resolve(response.data)
        }
      }
      
      instance.socket.addEventListener('message', handler)
      setTimeout(() => {
        instance.socket.removeEventListener('message', handler)
        reject(new Error('Timeout'))
      }, 30000)
    })
  }
}
```

#### MessageRouter - 路由消息到正确的实例

```typescript
class MessageRouter {
  constructor(
    private instanceManager: InstanceManager,
    private imAdapter: IMAdapter
  ) {}
  
  async routeIncomingMessage(imMessage: IMMessage) {
    const text = imMessage.text
    
    // 解析用户意图
    const intent = this.parseIntent(text)
    
    switch (intent.type) {
      case 'command':
        await this.handleCommand(imMessage, intent)
        break
      case 'direct-message':
        await this.handleDirectMessage(imMessage, intent)
        break
      case 'select-instance':
        await this.handleSelectInstance(imMessage, intent)
        break
    }
  }
  
  private parseIntent(text: string): Intent {
    // /sessions - 列出所有实例的会话
    if (text.startsWith('/sessions')) {
      return { type: 'command', command: 'list-sessions' }
    }
    
    // /use <instance-id> - 选择实例
    if (text.startsWith('/use ')) {
      const instanceId = text.slice(5).trim()
      return { type: 'select-instance', instanceId }
    }
    
    // 默认：直接消息到当前选中的实例
    return { type: 'direct-message' }
  }
  
  private async handleCommand(imMessage: IMMessage, intent: Intent) {
    switch (intent.command) {
      case 'list-sessions':
        // 聚合所有实例的会话
        const allSessions = await this.instanceManager.getAllSessions()
        
        // 按实例分组显示
        const grouped = groupBy(allSessions, 'instanceId')
        let text = '📂 所有会话\n\n'
        
        for (const [instanceId, sessions] of Object.entries(grouped)) {
          const instance = this.instanceManager.getInstance(instanceId)
          text += `**${instanceId}** (${instance?.workspace})\n`
          sessions.forEach(s => {
            text += `  \`${s.id}\`: ${s.title || '未命名'}\n`
          })
          text += '\n'
        }
        
        await this.imAdapter.sendMessage({
          text,
          parseMode: 'entities',
          // ... entities
        })
        break
    }
  }
  
  private async handleDirectMessage(imMessage: IMMessage, intent: Intent) {
    // 获取用户当前选中的实例
    const userContext = await this.getUserContext(imMessage.user.id)
    const instanceId = userContext.selectedInstance
    
    if (!instanceId) {
      await this.imAdapter.sendMessage({
        text: '请先选择实例：/use <instance-id>\n或使用 /sessions 查看可用实例',
      })
      return
    }
    
    // 转发消息到对应实例
    const response = await this.instanceManager.sendToInstance(
      instanceId,
      {
        type: 'prompt',
        text: imMessage.text,
        user: imMessage.user
      }
    )
    
    // 将响应发送回 IM
    await this.imAdapter.sendMessage({
      text: response.text,
      parseMode: 'entities',
      // ... entities
    })
  }
}
```

### 3.3 OpenCode 端（Plugin）

在 OpenCode 中创建一个轻量级插件，连接到 Bridge Service：

```typescript
// opencode-bridge-client.ts
import type { Plugin } from "@opencode-ai/plugin"

export class BridgeClientPlugin implements Plugin {
  name = "bridge-client"
  
  private socket: WebSocket
  private config: BridgeConfig
  
  async onInit(input: PluginInput) {
    this.config = input.config.bridge || {}
    
    // 连接到 Bridge Service
    this.socket = new WebSocket(this.config.serviceUrl)
    
    this.socket.onopen = () => {
      // 注册自己
      this.socket.send(JSON.stringify({
        type: 'register',
        instanceId: this.config.instanceId || process.cwd(),
        workspace: process.cwd(),
        authToken: this.config.authToken
      }))
    }
    
    this.socket.onmessage = async (event) => {
      const message = JSON.parse(event.data)
      
      switch (message.type) {
        case 'prompt':
          // 转发到当前 session
          const result = await input.client.session.prompt({
            path: { id: message.sessionId },
            body: { parts: [{ type: 'text', text: message.text }] }
          })
          
          // 返回响应
          this.socket.send(JSON.stringify({
            type: 'response',
            requestId: message.requestId,
            data: result
          }))
          break
          
        case 'list-sessions':
          const sessions = await input.client.session.list()
          this.socket.send(JSON.stringify({
            type: 'response',
            requestId: message.requestId,
            data: sessions
          }))
          break
      }
    }
    
    // 转发 OpenCode 事件到 Bridge
    input.onQuestionAsked = async (info) => {
      this.socket.send(JSON.stringify({
        type: 'event',
        event: 'question.asked',
        data: info
      }))
    }
    
    input.onPermissionAsked = async (info) => {
      this.socket.send(JSON.stringify({
        type: 'event',
        event: 'permission.asked',
        data: info
      }))
    }
  }
}
```

## 4. 部署方案

### 4.1 独立服务模式

```yaml
# docker-compose.yml
version: '3.8'

services:
  bridge-service:
    build: .
    ports:
      - "3001:3001"  # WebSocket + HTTP
    environment:
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - PORT=3001
    volumes:
      - ./data:/app/data  # 持久化用户状态
    restart: unless-stopped
```

### 4.2 OpenCode 插件配置

```typescript
// opencode.config.ts
export default {
  plugins: [
    {
      name: "bridge-client",
      config: {
        serviceUrl: "ws://localhost:3001",
        instanceId: "project-a",  // 唯一标识
        authToken: "xxx"
      }
    }
  ]
}
```

## 5. 用户体验

### 5.1 在 Telegram 中的交互

```
用户: /sessions
Bot: 
📂 所有会话

**project-a** (/Users/alice/project-a)
  `ses_xxx1`: 重构登录模块
  `ses_xxx2`: 优化数据库查询

**project-b** (/Users/bob/project-b)
  `ses_yyy1`: 新功能开发

用户: /use project-a
Bot: ✅ 已切换到 project-a 实例

用户: 帮我优化这段代码
Bot: [转发到 project-a 实例处理]
```

### 5.2 智能路由

- 自动识别 session ID 前缀（如 `project-a:ses_xxx`）
- 记住用户最后使用的实例
- 支持实例别名（快捷方式）

## 6. 优势对比

| 特性 | 原方案（单实例） | 新方案（BaaS） |
|------|----------------|---------------|
| 多实例支持 | ❌ 只能一个 | ✅ 同时多个 |
| 会话隔离 | ❌ 相互覆盖 | ✅ 完全隔离 |
| 集中管理 | ❌ 分散 | ✅ 统一入口 |
| 横向扩展 | ❌ 困难 | ✅ 容易 |
| 复杂性 | ✅ 简单 | ❌ 较复杂 |
| 实时性 | ✅ 高 | ✅ 高（WebSocket）|

## 7. 实现路线图

### Phase 1: 基础服务（2周）
- [ ] WebSocket 服务端
- [ ] 实例管理器
- [ ] 基础消息转发

### Phase 2: 完整功能（2周）
- [ ] 多 IM 平台支持
- [ ] 用户状态管理
- [ ] 事件转发（questions, permissions）

### Phase 3: 优化（1周）
- [ ] 断线重连
- [ ] 负载均衡
- [ ] 监控和日志

## 8. 核心代码入口

```typescript
// src/server/index.ts
import { WebSocketServer } from './websocket-server'
import { InstanceManager } from './instance-manager'
import { MessageRouter } from './router/message-router'
import { TelegramAdapter } from '../adapters/telegram'

async function main() {
  // 1. 创建实例管理器
  const instanceManager = new InstanceManager()
  
  // 2. 创建 IM 适配器
  const telegramAdapter = new TelegramAdapter()
  await telegramAdapter.initialize({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  })
  
  // 3. 创建消息路由器
  const router = new MessageRouter(instanceManager, telegramAdapter)
  
  // 4. 设置消息处理器
  telegramAdapter.onMessage((message) => {
    router.routeIncomingMessage(message)
  })
  
  // 5. 启动 WebSocket 服务器
  const wss = new WebSocketServer({
    port: parseInt(process.env.PORT || '3001'),
    instanceManager
  })
  
  console.log('Bridge Service started on port', process.env.PORT || '3001')
}

main()
```

---

需要我实现具体的核心代码吗？