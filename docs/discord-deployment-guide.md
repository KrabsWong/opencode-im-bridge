# Discord 集成部署指南

## 概述

本指南介绍如何配置和部署 Bridge Hub 的 Discord 集成功能。

## 方案对比

| 平台 | 优势 | 劣势 |
|------|------|------|
| **Telegram** | 简单直接，无需服务器配置 | 多实例消息混杂，切换不便 |
| **Discord** | 物理隔离（Thread），并发友好 | 需要额外配置 Bot 和频道 |

## 前置要求

1. Discord 账号
2. 一个 Discord 服务器（普通服务器即可，不需要 Community）
3. Node.js 18+ 和 npm/pnpm

---

## 第一步：创建 Discord Bot

### 1.1 访问 Discord Developer Portal

打开 [Discord Developer Portal](https://discord.com/developers/applications)

### 1.2 创建新 Application

1. 点击 **"New Application"** 按钮
2. 输入应用名称，如 `OpenCode Bridge Hub`
3. 点击 **Create**

### 1.3 获取 Bot Token

1. 在左侧菜单点击 **"Bot"**
2. 点击 **"Reset Token"**（如果是新创建的 Bot，直接点击 Copy）
3. **⚠️ 立即复制保存 Token**，关闭后将无法再次查看

Token 格式类似（示例，非真实）：
```
YOUR_BOT_TOKEN_HERE.xxxxx.xxxxxxxxxxx
```

### 1.4 配置 Bot 权限

在同一页面，找到 **Privileged Gateway Intents**，启用以下选项：

- ✅ **MESSAGE CONTENT INTENT**（必须，用于读取消息内容）

点击 **Save Changes**

---

## 第二步：邀请 Bot 加入服务器

### 2.1 生成邀请链接

1. 在左侧菜单点击 **"OAuth2"** → **"URL Generator"**
2. 在 **SCOPES** 部分勾选：
   - ✅ `bot`
   - ✅ `applications.commands`（如需使用 Slash Commands）
3. 在 **BOT PERMISSIONS** 部分勾选：
   - ✅ **Send Messages**
   - ✅ **Send Messages in Threads**
   - ✅ **Create Public Threads**
   - ✅ **Manage Threads**
   - ✅ **Read Message History**
   - ✅ **Embed Links**
   - ✅ **Attach Files**
   - ✅ **Add Reactions**
   - ✅ **Use External Emojis**
   - ✅ **Use Slash Commands**（如需使用 Slash Commands）

### 2.2 复制生成的 URL

在页面底部 **GENERATED URL** 处，点击 Copy。

链接格式类似：
```
https://discord.com/api/oauth2/authorize?client_id=1296183412683143674&permissions=309237647360&scope=bot%20applications.commands
```

### 2.3 邀请 Bot

1. 将链接粘贴到浏览器地址栏
2. 选择你要添加 Bot 的服务器
3. 点击 **Continue** → **Authorize**
4. 完成人机验证

---

## 第三步：获取 Channel ID

### 3.1 启用开发者模式

1. 打开 Discord 客户端
2. 点击 **用户设置**（左下角齿轮图标）
3. 进入 **高级**（Advanced）
4. 启用 **开发者模式**（Developer Mode）

### 3.2 获取频道 ID

1. 在你想要创建 Thread 的文字频道上 **右键点击**
2. 选择 **复制频道 ID**（Copy Channel ID）
3. 保存这个 ID（19位数字）

示例：
```
1296184567890123456
```

---

## 第四步：配置 Bridge Hub

### 4.1 编辑环境变量文件

在项目根目录创建或编辑 `.env` 文件：

```bash
# 基础配置
PORT=38471
AUTH_TOKEN=your-secure-auth-token

# Discord 配置（使用 Discord 时必需）
USE_DISCORD=true
DISCORD_BOT_TOKEN=your-bot-token-from-discord-developer-portal
DISCORD_CHANNEL_ID=your-channel-id-here

# 可选：用户权限控制
ADMIN_USERS=your-discord-user-id
ALLOWED_CHATS=
```

### 4.2 获取你的 Discord User ID

如需配置 `ADMIN_USERS`：

1. 在 Discord 中右键点击自己的头像
2. 选择 **复制用户 ID**
3. 粘贴到 `ADMIN_USERS` 中

---

## 第五步：启动服务

### 5.1 安装依赖

```bash
cd bridge-hub
npm install
```

### 5.2 构建项目

```bash
npm run build
```

### 5.3 启动服务

```bash
npm start
```

或使用 `tsx` 直接运行（开发模式）：

```bash
npx tsx src/index.ts
```

---

## 第六步：验证部署

### 6.1 检查日志

成功启动后，你应该看到类似输出：

```
🚀 Starting Bridge Hub...
📡 WebSocket port: 38471
📱 Using Discord adapter
WebSocket server started on port 38471
✅ Bridge Hub started successfully!

📋 Usage:
   1. Configure plugins to connect to this hub
   2. Use discord to interact with instances
```

### 6.2 测试 Instance 连接

1. 启动一个配置了 Bridge Hub 的 OpenCode 实例
2. 在 Discord 中观察：
   - 当 Instance 连接时，Bot 会在频道中发送 "Instance Connected" 消息
   - 自动创建一个 Thread（标题为工作目录名）
   - 后续消息都会发送到这个 Thread 中

### 6.3 测试消息发送

在 Instance 对应的 Thread 中发送消息，OpenCode 应该会处理并回复。

---

## 环境变量参考

| 变量名 | 必需 | 说明 |
|--------|------|------|
| `PORT` | 否 | WebSocket 端口，默认 38471 |
| `AUTH_TOKEN` | 是 | 认证令牌（自动生成或手动设置） |
| `USE_DISCORD` | 否 | 设为 `true` 优先使用 Discord |
| `DISCORD_BOT_TOKEN` | 是* | Discord Bot Token |
| `DISCORD_CHANNEL_ID` | 是* | Discord 文字频道 ID |
| `TELEGRAM_BOT_TOKEN` | 是* | Telegram Bot Token（使用 Telegram 时） |
| `ADMIN_USERS` | 否 | 允许使用的 Discord 用户 ID，逗号分隔 |
| `ALLOWED_CHATS` | 否 | 允许的频道 ID（当前未使用） |

*注：使用 Discord 时需要 `DISCORD_BOT_TOKEN` 和 `DISCORD_CHANNEL_ID`；使用 Telegram 时需要 `TELEGRAM_BOT_TOKEN`。

---

## 常见问题

### Q1: Bot 无法发送消息

**检查清单：**
1. Bot 是否已加入服务器？
2. Bot 在频道中是否有 **Send Messages** 权限？
3. 频道是否对 Bot 角色隐藏？
4. 检查 Bot Token 是否正确复制（无多余空格）

### Q2: Thread 没有自动创建

**可能原因：**
1. 频道 ID 错误（确认复制的是频道 ID，不是服务器 ID）
2. Bot 没有 **Create Public Threads** 权限
3. 频道类型不支持 Thread（必须是普通文字频道）

### Q3: 消息发送成功但看不到回复

**检查清单：**
1. OpenCode 实例是否正确连接到 Bridge Hub？
2. 检查 Bridge Hub 日志是否有错误
3. 确认消息是发送在 Thread 中，不是父频道

### Q4: 如何切换回 Telegram？

修改 `.env`：
```bash
# 注释掉或删除 Discord 配置
# USE_DISCORD=true
# DISCORD_BOT_TOKEN=...
# DISCORD_CHANNEL_ID=...

# 确保 Telegram 配置存在
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
```

---

## 架构说明

### Thread 生命周期

```
Instance 连接
    ↓
发送 "Instance Connected" 消息到频道
    ↓
基于消息创建 Thread
    ↓
所有后续对话在该 Thread 中进行
    ↓
Instance 断开
    ↓
自动归档 Thread
```

### 消息隔离

- **每个 Instance 一个 Thread**：消息物理隔离，不会混杂
- **Thread 自动归档**：7天无活动自动归档，保持频道整洁
- **Thread 标题**：使用工作目录名，直观识别

---

## 升级指南

### 从 Telegram 迁移到 Discord

1. 按本指南配置 Discord Bot
2. 更新 `.env` 文件
3. 重启 Bridge Hub
4. 重新连接 OpenCode 实例（会自动创建 Thread）

### 同时使用 Telegram 和 Discord

当前版本不支持同时启用两个 Adapter。如需切换，修改 `.env` 后重启即可。

---

## 故障排除

### 查看详细日志

```bash
DEBUG=1 npm start
```

### 测试 Discord API

使用 curl 测试 Bot Token：

```bash
curl -H "Authorization: Bot YOUR_BOT_TOKEN" \
  https://discord.com/api/v10/users/@me
```

### 重新生成 Bot Token

如果 Token 泄露：
1. 进入 Discord Developer Portal
2. 找到你的 Application → Bot
3. 点击 **Reset Token**
4. 更新 `.env` 文件
5. 重启服务

---

## 安全建议

1. **不要将 Token 提交到 Git**：使用 `.env` 文件并在 `.gitignore` 中忽略
2. **限制 Bot 权限**：只授予必需的最小权限
3. **使用 ADMIN_USERS**：限制只有特定用户可以使用 Bot
4. **定期轮换 Token**：建议每 3-6 个月重置一次

---

如有其他问题，请查看项目 README 或提交 Issue。
