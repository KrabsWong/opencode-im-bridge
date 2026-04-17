---
name: telegram-image-sender
description: Send images to Telegram when the user wants to view architecture diagrams, system structure diagrams, or any predefined visual resources. Use this skill whenever the user mentions wanting to see diagrams, architecture, system structure, workflow charts, or visual representations of the system. Trigger on phrases like "show me the architecture", "architecture diagram", "系统架构图", "流程图", or when the user wants to understand the system visually.
---

# Telegram Image Sender

Send predefined images to the user's Telegram chat through the IM Bridge plugin.

## When to Use

Use this skill when the user expresses interest in seeing:

- **Architecture diagrams** - "show me the architecture", "architecture diagram", "系统架构图"
- **System structure** - "how is the system designed", "system structure", "系统结构"
- **Workflow charts** - "workflow diagram", "流程图", "工作流程"
- **Visual documentation** - any request to view visual representations

### Trigger Phrases (non-exhaustive)

- "给我看看架构图"
- "architecture diagram"
- "系统是怎么设计的"
- "show me the workflow"
- "流程图"
- "structure diagram"
- "给我发张架构图到 Telegram"

## Usage

When you detect the user wants to see an image, include the image trigger marker in your response:

### Format

```
[SEND_IMAGE:image_identifier]
```

Or with a custom caption:

```
[SEND_IMAGE:image_identifier|Custom caption text]
```

### Available Images

| Identifier | Description | Use When |
|-----------|-------------|----------|
| `architecture` | System architecture diagram showing OpenCode IM Bridge components, workflow, and commands | User asks about system architecture, structure, or overall design |

## Examples

### Example 1: Basic Usage

**User:** "给我看看架构图"

**Your Response:**
```
这是 OpenCode IM Bridge 的系统架构图：

[SEND_IMAGE:architecture]

这个架构图展示了三个主要组件：
1. **Telegram Bot** - 接收用户消息、发送 AI 回复
2. **IM Bridge** - 消息格式转换、事件监听分发  
3. **OpenCode** - AI 助手执行、问题/权限管理
```

### Example 2: With Custom Caption

**User:** "系统是怎么设计的？"

**Your Response:**
```
系统采用分层架构设计：

[SEND_IMAGE:architecture|系统分层架构：展示三层组件交互]

**三层架构：**
- **表现层**：Telegram Bot 负责用户交互
- **逻辑层**：IM Bridge 处理消息转换和事件分发
- **数据层**：OpenCode 管理会话和 AI 执行
```

### Example 3: Multiple Images (Future)

**User:** "show me all the diagrams"

**Your Response:**
```
Here are the available diagrams:

[SEND_IMAGE:architecture|System architecture overview]

More diagrams can be added to the image library as needed.
```

## How It Works

1. **You include the marker** in your response (e.g., `[SEND_IMAGE:architecture]`)
2. **IM Bridge detects** the marker automatically
3. **Image is sent** to Telegram via the Bot API
4. **Marker is removed** from the final message (user never sees it)
5. **User receives** both the image and your explanatory text

## Image Library

Images are defined in the plugin's `IMAGE_LIBRARY` constant. Current available images:

- **`architecture`** - `/path/to/architecture.png`
  - Shows: Telegram Bot ↔ IM Bridge ↔ OpenCode flow
  - Includes: Command list, workflow steps, component descriptions

### Adding New Images

To add new images, the user needs to:
1. Add image file to the plugin directory
2. Update `IMAGE_LIBRARY` in `src/core/bridge.ts`
3. Rebuild and restart OpenCode
4. Update this skill's "Available Images" section

## Important Notes

- **Format matters**: The marker must be exact `[SEND_IMAGE:identifier]` with no extra spaces
- **Case sensitive**: Image identifiers are lowercase (e.g., `architecture`, not `Architecture`)
- **One at a time**: Currently only one image per response (markers are processed sequentially)
- **Bridge must be running**: IM Bridge needs to be connected to Telegram for images to send
- **Marker auto-removal**: Users never see the `[SEND_IMAGE:...]` text in their Telegram

## Troubleshooting

If the image doesn't send:
1. Check that the identifier matches exactly (case-sensitive)
2. Verify IM Bridge is running (`/sessions` should work)
3. Check logs at `.opencode/im-bridge.log`
4. Ensure the image file exists at the configured path

## Technical Details

- **Processing**: Markers are detected by regex pattern `/\[SEND_IMAGE:([^\]|]+)(?:\|([^\]]*))?\]/g`
- **API**: Uses Telegram Bot API `sendPhoto` endpoint
- **Format**: Supports PNG images (other formats may work but not tested)
- **Size limit**: Subject to Telegram's limits (typically 10MB for photos)
