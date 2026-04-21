# Discord 集成验证指南

本文档提供一步步的验证流程，确保 Discord 集成功能正常工作。

## 前置检查清单

在开始验证前，请确认：

- [ ] 已按照 `docs/discord-deployment-guide.md` 完成配置
- [ ] 已获取 `DISCORD_BOT_TOKEN` 和 `DISCORD_CHANNEL_ID`
- [ ] Bot 已加入目标 Discord 服务器
- [ ] Bot 在频道中有发送消息和创建 Thread 的权限

---

## 第一步：环境检查

### 1.1 验证环境变量

```bash
cd bridge-hub
cat .env | grep -E "USE_DISCORD|DISCORD_BOT_TOKEN|DISCORD_CHANNEL_ID"
```

应该看到类似输出：
```
USE_DISCORD=true
DISCORD_BOT_TOKEN=MTI5NjE4MzQxMjY4MzE0MzY3NA.GVsR8x.xxxxxx
DISCORD_CHANNEL_ID=1296184567890123456
```

### 1.2 验证代码已构建

```bash
ls -la dist/adapters/discord.js
```

如果文件不存在，执行：
```bash
npm run build
```

---

## 第二步：启动服务验证

### 2.1 启动 Bridge Hub

```bash
npm start
```

### 2.2 检查启动日志

**✅ 成功标志：**

```
🚀 Starting Bridge Hub...
📡 WebSocket port: 38471
👥 Admin users: all users
💬 Allowed chats: all chats
📱 Using Discord adapter        <-- 关键：确认使用 Discord adapter
WebSocket server started on port 38471
✅ Bridge Hub started successfully!
```

**❌ 如果看到：**
```
📱 Using Telegram adapter
```
说明配置未生效，检查 `.env` 中 `USE_DISCORD=true` 是否设置。

**❌ 如果看到错误：**
```
Error: Discord adapter requires botToken and channelId
```
说明环境变量缺失，检查 `DISCORD_BOT_TOKEN` 和 `DISCORD_CHANNEL_ID`。

---

## 第三步：Instance 连接测试

### 3.1 启动 OpenCode 实例

在一个 OpenCode 项目中启用 Bridge Hub 插件：

```typescript
// opencode-plugin 配置
{
  "bridgeHub": {
    "enabled": true,
    "url": "ws://localhost:38471",
    "authToken": "your-auth-token"
  }
}
```

### 3.2 观察 Discord

当 OpenCode 实例连接时，检查 Discord 频道：

**✅ 成功标志 - 在频道中看到：**

1. **连接消息**：
   ```
   🤖 Instance Connected
   📁 Workspace: /path/to/project
   ⏰ Time: 2024/01/15 10:30:00
   
   [Embed 卡片]
   🚀 OpenCode Instance
   ID: /path/to/project
   Status: 🟢 Active
   ```

2. **自动创建 Thread**：
   - 消息下方会出现 Thread（线程）
   - Thread 标题为工作目录名（如 `project`）
   - Thread 显示 "1 new message" 或类似提示

**📸 截图示例：**
```
#general
├── 🤖 Instance Connected (消息)
└── 🧵 project (Thread - 自动创建)
```

---

## 第四步：消息发送测试

### 4.1 在 Thread 中发送消息

1. 点击进入刚创建的 Thread
2. 发送一条测试消息：
   ```
   你好，帮我写一个 hello world
   ```

### 4.2 观察响应

**✅ 成功标志：**

1. Bridge Hub 日志显示：
   ```
   [Discord] Received message from thread xxx: 你好，帮我写一个 hello world
   [MessageRouter] Routing message from user xxx to instance /path/to/project
   ```

2. OpenCode 收到消息并处理

3. Discord Thread 中收到回复：
   ```
   🦀 **蟹老板说：**
   
   [回复内容]
   
   Session: abc123
   Title: Hello World
   ```

**❌ 如果无响应：**
- 检查 Bridge Hub 日志是否有错误
- 确认 OpenCode 实例状态为 "connected"
- 检查 Thread ID 是否匹配

---

## 第五步：Thread 隔离验证

### 5.1 连接多个 Instance

启动第二个 OpenCode 实例（不同工作目录）。

### 5.2 验证隔离性

**✅ 成功标志：**

1. Discord 中创建了两个独立的 Thread
   ```
   #general
   ├── 🤖 Instance Connected (project1)
   ├── 🧵 project1 (Thread)
   ├── 🤖 Instance Connected (project2)
   └── 🧵 project2 (Thread)
   ```

2. 在 project1 的 Thread 发送消息，不会出现在 project2 的 Thread 中

3. 两个 Instance 独立响应各自 Thread 的消息

---

## 第六步：Question 功能测试

### 6.1 触发 Question 事件

在 OpenCode 中执行需要确认的操作，例如：

```typescript
// 在 OpenCode Agent 中
const result = await askQuestion({
  header: "文件操作确认",
  question: "是否要删除文件 old.txt？",
  options: [
    { label: "删除", value: "delete" },
    { label: "保留", value: "keep" }
  ]
});
```

### 6.2 观察 Discord

**✅ 成功标志：**

在对应的 Instance Thread 中看到：

```
🦀 **蟹老板说：**

**文件操作确认**

是否要删除文件 old.txt？

[删除] [保留] [拒绝回答]  <-- Button 按钮
```

### 6.3 测试 Button 点击

1. 点击 "删除" 按钮
2. **✅ 成功标志：**
   - 按钮消失（消息被编辑移除按钮）
   - OpenCode 收到回复并继续执行
   - Bridge Hub 日志显示：`[MessageRouter] Question reply sent: xxx`

---

## 第七步：Permission 功能测试

### 7.1 触发 Permission 事件

在 OpenCode 中执行需要权限的操作，例如：

```typescript
// 在 OpenCode Agent 中
const allowed = await requestPermission({
  permission: "file.write",
  patterns: ["/path/to/file.txt"]
});
```

### 7.2 观察 Discord

**✅ 成功标志：**

在对应的 Instance Thread 中看到：

```
🦀 **蟹老板说：**

**🦀 蟹老板请求权限**

**权限:** file.write

**路径:**
1. `/path/to/file.txt`

[允许一次] [总是允许] [拒绝]  <-- Button 按钮
```

### 7.3 测试权限按钮

1. 点击 "允许一次"
2. **✅ 成功标志：**
   - 按钮消失
   - OpenCode 收到权限确认并继续执行

---

## 第八步：Instance 断开测试

### 8.1 断开 OpenCode 实例

关闭 OpenCode 或禁用 Bridge Hub 插件。

### 8.2 观察 Discord

**✅ 成功标志：**

1. Bridge Hub 日志显示：
   ```
   Instance unregistered: /path/to/project
   [Discord] Instance /path/to/project disconnected, archiving thread...
   ```

2. Discord Thread 被归档（Archived）：
   - Thread 名称变灰
   - 显示 "Archived" 标签
   - 无法继续发送消息（除非手动取消归档）

---

## 第九步：API 直连测试（可选）

使用 curl 直接测试 Discord API：

### 9.1 测试 Bot Token

```bash
curl -H "Authorization: Bot YOUR_BOT_TOKEN" \
  https://discord.com/api/v10/users/@me
```

**✅ 成功响应：**
```json
{
  "id": "1296183412683143674",
  "username": "OpenCode Bridge Hub",
  "bot": true
}
```

### 9.2 测试发送消息

```bash
curl -X POST \
  -H "Authorization: Bot YOUR_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Test message from API"}' \
  https://discord.com/api/v10/channels/YOUR_CHANNEL_ID/messages
```

---

## 故障排除速查表

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| Bot 不响应 | Token 错误 | 重新复制 Token，确保无空格 |
| 不创建 Thread | 缺少权限 | 给 Bot 添加 "Create Public Threads" 权限 |
| 消息发送失败 | Channel ID 错误 | 确认复制的是频道 ID，不是服务器 ID |
| 收不到回复 | Instance 未连接 | 检查 OpenCode 插件配置和日志 |
| Button 无响应 | 未实现交互端点 | 当前版本使用轮询，确保 Bridge Hub 运行中 |
| Thread 未归档 | 断开时出错 | 检查 Bridge Hub 日志中的错误信息 |

---

## 验证通过标准

所有以下测试均通过，即表示 Discord 集成验证成功：

- [ ] Bridge Hub 启动日志显示 "Using Discord adapter"
- [ ] Instance 连接时自动创建 Thread
- [ ] 在 Thread 中发送消息，OpenCode 能收到
- [ ] OpenCode 回复能显示在 Thread 中
- [ ] 多个 Instance 有独立的 Thread
- [ ] Question 事件显示 Button 并可点击回复
- [ ] Permission 事件显示 Button 并可点击回复
- [ ] Instance 断开时 Thread 自动归档

---

## 后续步骤

验证全部通过后：

1. **提交反馈** - 记录验证结果和遇到的问题
2. **推送到远程** - `git push origin feat/discord-integration`
3. **创建 PR** - 如果准备合并到主分支
4. **更新 README** - 添加 Discord 使用说明

如有问题，请检查日志并参考 `docs/discord-deployment-guide.md` 的故障排除部分。
