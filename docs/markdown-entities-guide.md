# Markdown to Telegram Entities 使用指南

## 概述

新方案使用 `remark` + `unified` 生态将 Markdown 转换为纯文本 + Telegram Entities，完全避免了转义问题。

## 核心优势

1. **无需转义** - 直接发送纯文本，不担心特殊字符
2. **精确控制** - 使用 entities 数组精确定义格式范围
3. **容错性强** - 单个 entity 错误不影响整体消息
4. **支持嵌套** - 可以正确处理复杂嵌套格式

## 快速开始

### 1. 基本转换

```typescript
import { markdownToEntities } from 'opencode-im-bridge'

const markdown = `
**粗体文字** 和 *斜体文字*

\`\`\`typescript
const code = "示例"
\`\`\`

[链接文字](https://example.com)

~~删除线~~

| 列1 | 列2 |
|-----|-----|
| A   | B   |
`

const result = markdownToEntities(markdown)
// result.text: 纯文本内容
// result.entities: Telegram Entity 数组
```

### 2. 发送消息（Adapter 层）

```typescript
import { TelegramAdapter } from 'opencode-im-bridge'

const adapter = new TelegramAdapter()
await adapter.initialize({
  botToken: 'YOUR_BOT_TOKEN',
  chatId: 'YOUR_CHAT_ID'
})

// 使用 entities 模式发送
await adapter.sendMessage({
  text: result.text,
  parseMode: 'entities',
  entities: result.entities
})
```

### 3. 长消息分割

```typescript
import { splitEntities, utf16Length } from 'opencode-im-bridge'

// 如果消息超过 4096 UTF-16 字符，自动分割
const chunks = splitEntities(result.text, result.entities, 4096)

for (const chunk of chunks) {
  await adapter.sendMessage({
    text: chunk.text,
    parseMode: 'entities',
    entities: chunk.entities
  })
}
```

## 支持的 Markdown 语法

| Markdown | Telegram Entity | 示例 |
|---------|----------------|------|
| `**bold**` | `bold` | **粗体** |
| `*italic*` | `italic` | *斜体* |
| `` `code` `` | `code` | `代码` |
| ` ```code``` ` | `pre` | 代码块 |
| `[text](url)` | `text_link` | 链接 |
| `~~strike~~` | `strikethrough` | 删除线 |
| `> quote` | `blockquote` | 引用 |
| `# Heading` | `bold` | 标题（转为粗体） |
| `Table` | `pre` | 表格（转为等宽文本） |

## Bridge 层使用

在 `IMBridge` 中可以使用新方法发送 Markdown：

```typescript
// 在 bridge.ts 中
await this.sendMarkdownWithEntities(
  '[会话前缀]',           // 消息前缀
  '🦀 蟹老板说',          // 标题
  aiResponseMarkdown,     // AI 响应的 Markdown
  {
    keyboard: inlineKeyboard,  // 可选：内联键盘
    editMessageId: msgId       // 可选：编辑现有消息
  }
)
```

## 降级策略

如果 entities 模式发送失败，会自动降级：

1. **entities 模式失败** → 降级到 HTML 模式
2. **HTML 模式失败** → 降级到纯文本模式

```typescript
// 在 sendMessage 中自动处理
try {
  await adapter.sendMessage({
    text,
    parseMode: 'entities',
    entities
  })
} catch (error) {
  // 自动降级到 HTML 或纯文本
}
```

## 与旧方案对比

| 特性 | 旧方案 (HTML) | 新方案 (Entities) |
|-----|--------------|------------------|
| 转义需求 | 需要转义 `<>&` | **无需转义** |
| 容错性 | 标签不匹配即失败 | **单点故障不影响整体** |
| 嵌套支持 | ✅ 支持 | ✅ 支持 |
| 调试难度 | 中 | **低** |
| 特殊字符 | 需处理 | **原生支持** |

## 实现细节

### UTF-16 长度计算

Telegram 使用 UTF-16 码元计量偏移：

```typescript
// BMP 字符（如 ASCII、CJK）
utf16Length("Hello")  // 5
utf16Length("你好")   // 2

// 非 BMP 字符（如 emoji）
utf16Length("👍")     // 2 (代理对)
utf16Length("👨‍👩‍👧‍👦")   // 11 (复合 emoji)
```

### Entity 格式

```typescript
interface TelegramEntity {
  type: 'bold' | 'italic' | 'code' | 'pre' | 'text_link' | 'strikethrough' | 'blockquote'
  offset: number  // UTF-16 起始偏移
  length: number  // UTF-16 长度
  url?: string    // text_link 类型需要
  language?: string // pre 类型可选
}
```

## 注意事项

1. **Entities 优先** - 如果提供了 `entities` 数组，`parseMode` 会被忽略
2. **长度限制** - Telegram 消息限制 4096 UTF-16 字符，超过会自动分割
3. **向后兼容** - 旧代码使用 `parseMode: 'html'` 仍然正常工作

## 迁移指南

### 旧代码

```typescript
import { markdownToTelegramHtml } from './markdown.js'

const html = markdownToTelegramHtml(markdown)
await adapter.sendMessage({
  text: html,
  parseMode: 'html'
})
```

### 新代码

```typescript
import { markdownToEntities } from './markdown-entities.js'

const result = markdownToEntities(markdown)
await adapter.sendMessage({
  text: result.text,
  parseMode: 'entities',
  entities: result.entities
})
```

或者使用 Bridge 的便捷方法：

```typescript
await this.sendMarkdownWithEntities(
  prefix,
  title,
  markdown,
  { keyboard, editMessageId }
)
```
