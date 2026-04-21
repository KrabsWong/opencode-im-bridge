# Discord Thread 架构设计方案

> 调研时间：2026-04-21
> 适用场景：多 OpenCode Instance 管理
> 状态：待实施

---

## 1. 方案概述

### 核心思想
使用 Discord 的 **Forum Channel + Threads** 架构，实现每个 OpenCode Instance 对应一个独立的 Thread，彻底解决多实例消息混杂问题。

### 对比现有方案

| 维度 | Telegram（当前） | Discord Threads（提案） |
|------|-----------------|------------------------|
| **实例隔离** | ❌ 共享聊天，靠消息前缀区分 | ✅ 物理隔离（不同 thread）|
| **并发会话** | ❌ 需要手动切换 | ✅ 可同时与多个实例对话 |
| **历史消息** | ❌ 混合在一起 | ✅ 按实例分开展示 |
| **自动归档** | ❌ 无 | ✅ 7天无活动自动归档 |
| **权限管理** | ⚠️ 较简单 | ✅ 可细化到 thread 级别 |
| **视觉区分** | ⚠️ 靠 emoji 前缀 | ✅ thread 标题清晰区分 |

---

## 2. 架构设计

### 2.1 服务器结构

```
Discord Server: OpenCode Bridge Hub
├── 📁 Category: 管理
│   └── #announcements（系统公告）
│   └── #general（通用聊天）
│
├── 📁 Category: OpenCode Instances ⭐
│   └── 📋 Forum: #active-sessions（活跃实例）
│       ├── 🏷️ Tag: active
│       │   ├── 🧵 opencode-im-bridge
│       │   │   └── 📁 /Users/krabswang/Personal/opencode-im-bridge
│       │   ├── 🧵 my-project
│       │   │   └── 📁 /Users/krabswang/Projects/my-app
│       │   └── 🧵 work-project
│       │       └── 📁 /Users/krabswang/Work/company-project
│       │
│       └── 🏷️ Tag: idle
│           ├── 🧵 old-project（7天无活动，自动归档）
│           └── 🧵 temp-session（临时会话）
│
└── 📁 Category: 归档
    └── 📋 Forum: #archived-sessions
        └── 🧵 [自动移动长期不活跃的 threads]
```

### 2.2 Thread 命名规范

| 格式 | 示例 | 说明 |
|------|------|------|
| `{workspace-name}` | `opencode-im-bridge` | 使用目录名 |
| `{project}-{branch}` | `myapp-main` | 项目+分支 |
| `{client}-{project}` | `clientA-website` | 客户+项目 |

**自动更新标题**：当 session 生成智能标题后，可更新 thread 名称为 `{workspace} - {title}`

---

## 3. 技术实现

### 3.1 Thread 类型选择

推荐：**Forum Channel（类型 15）**

```javascript
// Forum Channel 特点
{
  "type": 15,  // GUILD_FORUM
  "name": "active-sessions",
  "topic": "OpenCode 活跃实例会话",
  "available_tags": [
    { "id": "1", "name": "active", "emoji": "🟢" },
    { "id": "2", "name": "idle", "emoji": "🟡" },
    { "id": "3", "name": "error", "emoji": "🔴" }
  ],
  "default_auto_archive_duration": 10080  // 7天
}
```

### 3.2 API 实现流程

#### 步骤 1：Instance 连接时创建 Thread

```http
POST /channels/{forum_channel_id}/threads
Content-Type: application/json
Authorization: Bot {token}

{
  "name": "opencode-im-bridge",
  "auto_archive_duration": 10080,  // 7天
  "message": {
    "content": "🤖 **Instance Connected**\n📁 **Workspace**: `/Users/krabswang/Personal/opencode-im-bridge`\n⏰ **Time**: 2026-04-21 14:30:00"
  },
  "applied_tags": ["1"]  // active tag
}
```

**响应**：
```json
{
  "id": "1234567890123456789",  // thread_id，后续发送消息使用
  "name": "opencode-im-bridge",
  "parent_id": "9876543210987654321",  // forum channel id
  "type": 11  // PUBLIC_THREAD
}
```

#### 步骤 2：存储映射关系

```typescript
// Bridge Hub 维护的映射
interface InstanceThreadMapping {
  instanceId: string;      // OpenCode workspace path
  threadId: string;        // Discord thread ID
  channelId: string;       // Forum channel ID
  userChatMap: Map<string, number>;  // userId -> Discord user ID
  lastActivity: number;    // 最后活动时间
}

// 存储
private instanceThreads: Map<string, InstanceThreadMapping> = new Map();
```

#### 步骤 3：发送消息到 Thread

```http
POST /channels/{thread_id}/messages
Content-Type: application/json

{
  "content": "🦀 **蟹老板说**\n\n处理完成！",
  "embeds": [...]  // 可选：富文本
}
```

#### 步骤 4：Instance 断开时归档 Thread

```http
PATCH /channels/{thread_id}
Content-Type: application/json

{
  "archived": true,
  "locked": false
}
```

### 3.3 消息格式适配

当前 Telegram 格式：
```
📁 `instance-id`
📋 `session-title`
🔑 `session-id`
──────────────
🦀 **蟹老板说：**

消息内容
```

Discord Thread 优化格式：
```
## Thread 标题: opencode-im-bridge

**Session**: session-xxx-xxx
**Title**: 优化性能
**Time**: 2026-04-21 14:30

🦀 蟹老板说：

消息内容
```

**改进点**：
- Thread 标题自带 instance 信息，无需在每条消息中重复
- 使用 Discord Embed 美化消息
- 支持代码块高亮、图片附件等

---

## 4. 功能映射

### 4.1 命令迁移

| Telegram 命令 | Discord 实现 | 说明 |
|--------------|-------------|------|
| `/instances` | `/list` | 显示所有 threads（即 instances）|
| `/use <id>` | 点击 Thread | 直接进入对应 thread |
| `/sessions` | `/sessions` | 在 thread 内显示该 instance 的 sessions |
| `/go` | 使用 Thread 列表 | Discord 原生支持快速切换 |
| `/cmd` | Slash Commands | Discord 原生斜杠命令 |
| 直接发送消息 | 在 Thread 内发送 | 无需切换，直接在对应 thread 聊天 |

### 4.2 事件处理

| 事件 | Telegram | Discord |
|------|----------|---------|
| **Instance 连接** | 发送系统消息 | 创建新 Thread + 首条消息 |
| **Instance 断开** | 发送系统消息 | 归档 Thread |
| **Question 询问** | 发送带按钮消息 | 发送带按钮消息（在 Thread 内）|
| **Permission 请求** | 发送带按钮消息 | 发送带按钮消息（在 Thread 内）|
| **AI 响应** | 发送消息 | 发送消息（无需前缀）|

---

## 5. 优势分析

### 5.1 用户体验提升

1. **物理隔离**：每个 instance 独立空间，消息绝不混杂
2. **并发友好**：可同时与多个 instance 对话，像同时开多个聊天窗口
3. **历史清晰**：thread 内只有该 instance 的消息，便于查找
4. **状态可见**：通过 thread 的 active/archived 状态一目了然

### 5.2 技术实现优势

1. **API 简单**：与发送频道消息 API 完全一致，只需替换 `channel_id` 为 `thread_id`
2. **自动管理**：Discord 自动归档不活跃 thread，无需手动清理
3. **权限灵活**：可对不同 thread 设置不同权限（如只读、管理员等）
4. **富媒体支持**：原生支持图片、文件、embeds 等

### 5.3 与 Telegram 对比

| 场景 | Telegram | Discord |
|------|----------|---------|
| **切换实例** | 输入 `/instances` → 点击 → 再点 `/sessions` → 点击 | 直接点击左侧 Thread 列表 |
| **查找历史** | 滚动查找，混杂所有实例 | 直接进入该 instance 的 thread |
| **同时对话** | 频繁切换，容易错乱 | 多线程并行，互不干扰 |
| **移动端** | 和桌面端一样混杂 | Thread 列表清晰，切换方便 |

---

## 6. 实施建议

### 6.1 迁移步骤

```
Phase 1: 基础架构
  1. 创建 Discord Server
  2. 配置 Forum Channel
  3. 实现 Discord Adapter（基于现有 TelegramAdapter）
  4. 实现 Thread 生命周期管理

Phase 2: 功能迁移
  1. 迁移消息发送逻辑
  2. 迁移命令处理（/sessions, /cmd 等）
  3. 迁移事件处理（Question, Permission）
  4. 测试多实例并发

Phase 3: 优化增强
  1. 添加 Thread 自动归档策略
  2. 实现 Thread 标题自动更新（基于 session title）
  3. 添加标签分类（active/idle/error）
  4. 美化消息格式（使用 Embeds）
```

### 6.2 配置建议

**Forum Channel 设置**：
- 名称：`active-sessions` 或 `opencode-instances`
- 默认归档时间：7天（10080分钟）
- 标签：
  - 🟢 active - 活跃中
  - 🟡 idle - 空闲
  - 🔴 error - 出错
  - 📦 archived - 手动归档

**Bot 权限**：
- `Manage Threads` - 创建、编辑、归档 threads
- `Send Messages in Threads` - 在 threads 中发送消息
- `Read Message History` - 读取历史消息
- `Embed Links` - 发送 embeds
- `Attach Files` - 发送文件

### 6.3 降级方案

如果 Forum Channel 不可用（非社区服务器）：
- 使用 **Text Channel + Public Threads**
- 通过 `POST /channels/{channel_id}/messages/{message_id}/threads` 创建 thread
- 功能相同，只是没有 Forum 的列表视图

---

## 7. 代码示例

### 7.1 Discord Adapter 核心方法

```typescript
class DiscordAdapter implements IMAdapter {
  private botToken: string
  private forumChannelId: string
  private instanceThreads: Map<string, string> = new Map() // instanceId -> threadId

  // Instance 连接时创建 Thread
  async createThreadForInstance(instanceId: string, workspace: string): Promise<string> {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${this.forumChannelId}/threads`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${this.botToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: workspace.split('/').pop() || instanceId,
          auto_archive_duration: 10080,
          message: {
            content: `🤖 **Instance Connected**\n📁 **Workspace**: \`${workspace}\``
          }
        })
      }
    )
    
    const thread = await response.json()
    this.instanceThreads.set(instanceId, thread.id)
    return thread.id
  }

  // 发送消息到指定 Thread
  async sendMessage(message: IMOutgoingMessage): Promise<{ messageId: string }> {
    const threadId = this.instanceThreads.get(message.instanceId)
    if (!threadId) throw new Error('Thread not found')

    const response = await fetch(
      `https://discord.com/api/v10/channels/${threadId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${this.botToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: message.text,
          embeds: message.embeds
        })
      }
    )
    
    const data = await response.json()
    return { messageId: data.id }
  }
}
```

### 7.2 Message Router 适配

```typescript
// 主要改动：不再需要在每条消息中显示 instance 信息
// 因为 Thread 标题已经包含

async handleDirectMessage(text: string, instanceId: string): Promise<void> {
  // 获取或创建 Thread
  let threadId = this.discordAdapter.getThreadId(instanceId)
  if (!threadId) {
    threadId = await this.discordAdapter.createThreadForInstance(
      instanceId,
      this.registry.getInstance(instanceId)!.workspace
    )
  }

  // 直接发送消息（无需前缀）
  await this.discordAdapter.sendMessage({
    threadId,
    text: `🦀 **蟹老板说：**\n\n${text}`
  })
}
```

---

## 8. 注意事项

### 8.1 限制与约束

1. **Thread 数量上限**：
   - 活跃 threads：服务器级别限制（通常几千个）
   - 归档 threads：无上限，但 API 获取有限制

2. **归档后无法发送**：
   - 归档的 thread 需要先取消归档才能发送消息
   - 可配置 Bot 自动取消归档

3. **用户权限**：
   - 用户必须加入 thread 才能看到消息
   - Bot 需将用户添加到 thread（如果是 private thread）

### 8.2 最佳实践

1. **自动归档管理**：
   ```typescript
   // 定期清理长期不活跃的 threads
   setInterval(() => {
     for (const [instanceId, threadId] of this.instanceThreads) {
       const lastActivity = this.getLastActivity(instanceId)
       if (Date.now() - lastActivity > 30 * 24 * 60 * 60 * 1000) {
         // 30天无活动，移动到新 Forum Channel
         this.moveToArchive(threadId)
       }
     }
   }, 24 * 60 * 60 * 1000)  // 每天检查
   ```

2. **Thread 标题同步**：
   ```typescript
   // 当 session 生成标题时，更新 thread 名称
   async updateThreadTitle(threadId: string, title: string) {
     await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
       method: 'PATCH',
       headers: { 'Authorization': `Bot ${this.botToken}` },
       body: JSON.stringify({ name: title.slice(0, 100) })  // Discord 限制 100 字符
     })
   }
   ```

---

## 9. 总结

### 核心结论

**Discord Thread 方案显著优于 Telegram**：
- ✅ 物理隔离解决消息混杂问题
- ✅ 原生支持多实例并发对话
- ✅ 自动归档简化生命周期管理
- ✅ 更好的用户体验和可维护性

### 实施优先级

**推荐实施**：⭐⭐⭐⭐⭐（强烈建议）

如果计划支持 Discord，这是最佳架构方案。

### 后续行动

1. 创建测试 Discord Server
2. 实现基础 Discord Adapter
3. 迁移核心功能（消息发送、命令处理）
4. 对比测试与 Telegram 的差异
5. 收集用户反馈优化

---

*文档版本：v1.0*
*最后更新：2026-04-21*
*作者：AI Assistant*
