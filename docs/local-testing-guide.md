# 本地测试指南

## 快速开始

### 步骤 1: 启动 Bridge Hub

```bash
# 进入 Bridge Hub 目录
cd bridge-hub

# 创建环境变量文件
cp ../.env.example .env

# 编辑 .env，填入你的 Telegram Bot Token
# TELEGRAM_BOT_TOKEN=your-bot-token-here

# 安装依赖并启动
npm install
npm start
```

启动成功后会看到：
```
🚀 Starting Bridge Hub...
📡 WebSocket port: 38471
👥 Admin users: all users
🤖 Telegram Bot: @YourBotName
🔑 Auth Token: xxxxxxxx
✅ Bridge Hub started successfully!

Usage:
   1. Configure plugins to connect to this hub
   2. Use Telegram bot to interact with instances
```

**注意**: 如果没设置 `AUTH_TOKEN`，会自动生成一个并显示在控制台，记下它。

---

### 步骤 2: 配置 OpenCode Plugin

在你要测试的 OpenCode 项目的 `.opencode/config.json` 中添加：

```json
{
  "plugin": [
    ["opencode-bridge-client", {
      "hubConfig": {
        "hubUrl": "ws://localhost:38471",
        "authToken": "your-auth-token"
      }
    }]
  ]
}
```

**配置说明**:
- `hubUrl`: Bridge Hub 的 WebSocket 地址（本地测试用 `ws://localhost:38471`）
- `authToken`: 认证令牌（从 Bridge Hub 启动日志中获取）
- `instanceId`: 可选，默认自动生成

---

### 步骤 3: 启动 OpenCode

在配置好 plugin 的项目目录中：

```bash
opencode
```

如果连接成功，你会在 Bridge Hub 的控制台看到：
```
Instance registered: project-a-abc123 (/Users/you/project-a)
```

---

### 步骤 4: 在 Telegram 中测试

1. **查看可用实例**
   ```
   /instances
   ```
   Bot 会返回：
   ```
   **所有实例**

   1. [已连接] `project-a-abc123`
      目录: /Users/you/project-a
   
   [选择: project-a-abc123]
   ```

2. **选择实例**
   ```
   /use project-a-abc123
   ```
   或点击上面的按钮

3. **发送消息**
   ```
   你好，现在是什么时间？
   ```
   Bot 会转发给 OpenCode，并把响应发回来。

4. **查看当前实例**
   ```
   /current
   ```

---

## 测试场景

### 场景 1: 多项目同时连接

1. 在 **项目 A** 的 `.opencode/config.json` 中配置 plugin
2. 在 **项目 B** 的 `.opencode/config.json` 中配置相同的 hubUrl 和 authToken
3. 分别启动两个 OpenCode 实例
4. 在 Telegram 中使用 `/instances` 应该能看到两个实例
5. 使用 `/use` 切换实例，发送消息验证是否正确路由

### 场景 2: Markdown 格式测试

选择实例后，发送以下消息测试格式：

```
**粗体文字**
*斜体文字*
`行内代码`
~~删除线~~
[链接](https://example.com)
```

在 Telegram 中应该看到正确格式化的消息。

### 场景 3: 代码块

```
请解释这段代码：
```python
def hello():
    print("Hello World")
```
```

### 场景 4: 断开重连

1. 停止 Bridge Hub (Ctrl+C)
2. 等待几秒后重新启动
3. OpenCode plugin 应该自动重连
4. 在 Telegram 中发送消息验证

---

## 调试技巧

### 查看 Bridge Hub 日志

Bridge Hub 会输出所有连接和消息日志：
```
New WebSocket connection
Instance registered: project-a (/Users/you/project-a)
Event from project-a: question.asked
```

### 查看 Plugin 日志

Plugin 会在项目目录的 `.opencode/hub-client.log` 中记录日志。

### 检查连接状态

在 Bridge Hub 控制台可以看到：
- 连接的实例列表
- 每个实例的 workspace
- 最后心跳时间

### 常见问题

**问题 1: Plugin 无法连接**
```
Error: Connection refused
```
- 检查 Bridge Hub 是否已启动
- 检查 `hubUrl` 是否正确（本地测试用 `ws://localhost:38471`）
- 检查防火墙设置

**问题 2: 认证失败**
```
Error: Invalid auth token
```
- 检查 `authToken` 是否与 Bridge Hub 设置一致
- 如果 Bridge Hub 自动生成 token，从控制台复制

**问题 3: Telegram 收不到消息**
- 检查是否已向 Bot 发送 `/start`
- 检查 `TELEGRAM_BOT_TOKEN` 是否正确
- 检查 `ADMIN_USERS` 是否包含你的用户 ID
- 检查 `ALLOWED_CHATS` 是否包含 Group ID（如果在 Group 中使用）

**问题 4: 消息路由错误**
- 检查是否已使用 `/use` 选择了实例
- 检查实例状态是否为 `connected`

**问题 5: Group 中无法使用**
- 检查 `ALLOWED_CHATS` 是否包含 Group ID
- Group ID 格式通常是 `-1001234567890`
- 将 Bot 加入 Group 后发送消息，查看 Bridge Hub 控制台获取 Group ID

---

## Group/频道白名单

如果你只想让 Bot 在特定的 Group 或频道中工作：

### 1. 获取 Group ID

将 Bot 加入 Group 后，在 Group 中发送一条消息，查看 Bridge Hub 控制台会看到：
```
Unauthorized access attempt: user=123456789, chat=-1001234567890
```

记下 `chat=` 后面的 Group ID（通常是 `-100` 开头）。

### 2. 配置白名单

在 `.env` 中设置：
```bash
# 只允许特定 Group
ALLOWED_CHATS=-1001234567890

# 允许多个 Group（逗号分隔）
ALLOWED_CHATS=-1001234567890,-1009876543210

# 同时限制用户和 Group
ADMIN_USERS=123456789
ALLOWED_CHATS=-1001234567890
```

### 3. 权限规则

- `ADMIN_USERS` 为空 + `ALLOWED_CHATS` 为空 = 允许所有人、所有 Group
- `ADMIN_USERS` 有值 + `ALLOWED_CHATS` 为空 = 只允许特定用户，但可以在任何 Group
- `ADMIN_USERS` 为空 + `ALLOWED_CHATS` 有值 = 允许所有人，但只能在特定 Group
- `ADMIN_USERS` 有值 + `ALLOWED_CHATS` 有值 = 必须同时满足用户和 Group 条件

---

## Docker 测试（可选）

如果你想用 Docker 运行 Bridge Hub：

```bash
cd bridge-hub

# 创建 .env 文件
cat > .env << EOF
PORT=38471
TELEGRAM_BOT_TOKEN=your-bot-token
AUTH_TOKEN=your-auth-token
EOF

# 启动
docker-compose up -d

# 查看日志
docker-compose logs -f
```

然后 OpenCode plugin 配置改为：
```json
{
  "hubConfig": {
    "hubUrl": "ws://localhost:38471",
    "authToken": "your-auth-token"
  }
}
```

---

## 测试检查清单

- [ ] Bridge Hub 启动成功
- [ ] Plugin 连接到 Bridge Hub
- [ ] Telegram Bot 响应 `/help` 命令
- [ ] `/instances` 显示已连接的实例
- [ ] `/use` 可以选择实例
- [ ] `/sessions` 显示 Session 列表
- [ ] 直接发送消息能收到响应
- [ ] Markdown 格式正确显示
- [ ] 代码块正确显示
- [ ] 多项目同时连接正常
- [ ] 断线后能自动重连
- [ ] `/cmd` 命令面板正常工作
- [ ] Question/Permission 事件正常显示
