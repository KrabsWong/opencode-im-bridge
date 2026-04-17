# Usage Examples by Scenario

## Scenario 1: Architecture Overview

**User Context**: New user, wants to understand the system

**User Says**: "这个系统是怎么工作的？给我看看架构"

**Your Response**:
```
OpenCode IM Bridge 是一个连接 OpenCode AI 和 Telegram 的双向通信桥梁。

[SEND_IMAGE:architecture]

**核心组件：**

1. **Telegram Bot** (左侧)
   - 接收用户消息和命令
   - 发送 AI 回复和通知
   - 提供交互按钮（权限确认、问题回答）

2. **IM Bridge** (中间)
   - 消息格式转换
   - 事件监听和分发
   - 命令解析执行
   - 会话状态管理

3. **OpenCode** (右侧)
   - AI 助手执行代码
   - 问题提问机制
   - 权限请求系统
   - 会话管理

**工作流程：**
1. 用户在 Telegram 发送消息
2. Bridge 转发到 OpenCode
3. AI 处理并生成回复
4. 回复通过 Bridge 返回 Telegram
5. 如果需要确认，会推送按钮到 Telegram
```

## Scenario 2: Specific Feature Question

**User Says**: "architecture diagram please"

**Your Response**:
```
Here's the system architecture diagram:

[SEND_IMAGE:architecture|OpenCode IM Bridge Architecture]

The architecture shows the bidirectional communication flow between Telegram and OpenCode through the IM Bridge middleware.
```

## Scenario 3: Command Explanation

**User Says**: "怎么用 /sessions 命令？有图吗"

**Your Response**:
```
`/sessions` 命令用于查看当前活跃的 OpenCode 会话。

[SEND_IMAGE:architecture]

从架构图可以看到，Bridge 会查询 OpenCode 的会话列表，然后展示给你：
- 会话标题
- 完整会话 ID
- 当前状态（运行中/重试中/空闲）
- 任务完成情况

**使用步骤：**
1. 在 Telegram 发送 `/sessions`
2. 查看返回的会话列表（最近1小时内活跃的）
3. 点击按钮或发送 `/use <会话ID>` 选择会话
4. 之后的消息会直接发送到该会话
```

## Scenario 4: Comparison/Analysis

**User Says**: "对比下使用 Bridge 前后的区别"

**Your Response**:
```
使用 IM Bridge 前后的主要区别：

**使用前：**
- 必须打开 OpenCode 网页/应用
- 在浏览器中与 AI 交互
- 无法离开电脑时持续对话

**使用后（基于下图架构）：**

[SEND_IMAGE:architecture]

- 通过 Telegram 手机/桌面端随时交互
- 收到通知推送（问题、权限请求）
- 可以直接在通知中点击按钮回复
- 多设备同步，手机也能操作 AI

**核心优势：**
Bridge 层让 Telegram 成为了 OpenCode 的"遥控器"，你可以随时随地与 AI 互动。
```

## Scenario 5: Troubleshooting

**User Says**: "图片没发送成功，怎么回事"

**Your Response**:
```
图片发送失败可能的原因：

[SEND_IMAGE:architecture|检查 Bridge 连接状态]

**排查步骤：**

1. **检查 Bridge 是否运行**
   - 发送 `/sessions` 看是否有响应
   - 如果报错，Bridge 可能未启动

2. **检查图片标识**
   - 当前支持的图片：`architecture`
   - 确保拼写正确（小写）

3. **查看日志**
   - 日志位置：`.opencode/im-bridge.log`
   - 搜索 "SEND_IMAGE" 或 "sendPhoto"

4. **检查 Telegram 连接**
   - Bridge 需要连接到 Telegram Bot
   - 如果其他命令也失败，可能是连接问题

如果以上都正常但仍失败，请提供日志内容以便进一步排查。
```

## Anti-Patterns (Don't Do This)

**❌ Don't:**
- Send images without context
- Use wrong identifier: `[SEND_IMAGE:Architecture]` (uppercase)
- Add spaces: `[SEND_IMAGE: architecture]`
- Forget brackets: `SEND_IMAGE:architecture`
- Use multiple images in one response (not supported yet)

**✅ Do:**
- Always provide explanatory text
- Use correct format: `[SEND_IMAGE:architecture]`
- Include relevant context before/after image
- Verify the image adds value to the explanation
