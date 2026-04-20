/**
 * Markdown to Telegram Entities Converter
 * 
 * 使用 remark + unified 生态将 Markdown 转换为纯文本 + Telegram Entities
 * 完全避免转义问题，提供更好的容错性
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { toString } from 'mdast-util-to-string'
import type { Root, Content, Table, PhrasingContent, BlockContent } from 'mdast'

/**
 * Telegram 支持的 Entity 类型
 */
export interface TelegramEntity {
  type: 'bold' | 'italic' | 'code' | 'pre' | 'text_link' | 'strikethrough' | 'blockquote' | 'underline' | 'spoiler'
  offset: number
  length: number
  url?: string
  language?: string
}

/**
 * 转换结果
 */
export interface MarkdownConvertResult {
  text: string
  entities: TelegramEntity[]
}

/**
 * 计算 UTF-16 码元长度（Telegram 要求）
 * 
 * - BMP 字符（U+0000-U+FFFF）：1 个码元
 * - 非 BMP 字符（U+10000+，如 emoji）：2 个码元（代理对）
 */
export function utf16Length(str: string): number {
  let length = 0
  for (const char of str) {
    length += char.codePointAt(0)! > 0xFFFF ? 2 : 1
  }
  return length
}

/**
 * 计算字符串显示宽度（CJK字符算2）
 */
function stringWidth(str: string): number {
  let width = 0
  for (const char of str) {
    const code = char.codePointAt(0)!
    // CJK字符、全角字符、emoji
    if ((code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3000 && code <= 0x303f) ||
        (code >= 0xff00 && code <= 0xffef) ||
        (code >= 0x2600 && code <= 0x26ff) ||
        (code >= 0x2700 && code <= 0x27bf) ||
        (code >= 0x1f300 && code <= 0x1f9ff)) {
      width += 2
    } else {
      width += 1
    }
  }
  return width
}

/**
 * 将 Markdown 转换为纯文本 + Telegram Entities
 * 
 * @param markdown Markdown 文本
 * @returns 包含纯文本和 entities 的结果
 */
export function markdownToEntities(markdown: string): MarkdownConvertResult {
  // 1. 使用 remark 解析为 AST
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm) // 支持 GFM（表格、删除线等）
  
  const tree = processor.parse(markdown) as Root
  
  // 2. 遍历 AST，生成纯文本和 entities
  const result = extractEntitiesFromTree(tree)
  
  return result
}

/**
 * 检查节点是否需要分隔符（块级元素）
 */
function needsSeparator(node: Content): boolean {
  return ['heading', 'paragraph', 'code', 'blockquote', 'list', 'table', 'thematicBreak'].includes(node.type)
}

/**
 * 处理行内节点（递归处理）
 */
function processInlineNode(
  node: PhrasingContent,
  text: string,
  entities: TelegramEntity[],
  currentOffset: number
): { text: string; currentOffset: number } {
  let newText = text
  let newOffset = currentOffset

  switch (node.type) {
    // 纯文本节点
    case 'text': {
      newText += node.value
      newOffset += utf16Length(node.value)
      break
    }

    // 粗体 **text** 或 __text__
    case 'strong': {
      const content = toString(node)
      const start = newOffset
      newText += content
      const length = utf16Length(content)
      entities.push({ type: 'bold', offset: start, length })
      newOffset += length
      break
    }

    // 斜体 *text* 或 _text_
    case 'emphasis': {
      const content = toString(node)
      const start = newOffset
      newText += content
      const length = utf16Length(content)
      entities.push({ type: 'italic', offset: start, length })
      newOffset += length
      break
    }

    // 行内代码 `code`
    case 'inlineCode': {
      const start = newOffset
      newText += node.value
      const length = utf16Length(node.value)
      entities.push({ type: 'code', offset: start, length })
      newOffset += length
      break
    }

    // 链接 [text](url)
    case 'link': {
      const content = toString(node)
      const start = newOffset
      newText += content
      const length = utf16Length(content)
      entities.push({
        type: 'text_link',
        offset: start,
        length,
        url: node.url
      })
      newOffset += length
      break
    }

    // 删除线 ~~text~~ (GFM)
    case 'delete': {
      const content = toString(node)
      const start = newOffset
      newText += content
      const length = utf16Length(content)
      entities.push({ type: 'strikethrough', offset: start, length })
      newOffset += length
      break
    }

    // 硬换行
    case 'break': {
      newText += '\n'
      newOffset += 1
      break
    }

    // 其他行内元素（递归处理子节点）
    default: {
      if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children) {
          const result = processInlineNode(child as PhrasingContent, newText, entities, newOffset)
          newText = result.text
          newOffset = result.currentOffset
        }
      }
    }
  }

  return { text: newText, currentOffset: newOffset }
}

/**
 * 处理块级节点
 */
function processBlockNode(
  node: BlockContent,
  text: string,
  entities: TelegramEntity[],
  currentOffset: number
): { text: string; currentOffset: number } {
  let newText = text
  let newOffset = currentOffset

  switch (node.type) {
    // 段落
    case 'paragraph': {
      for (const child of node.children) {
        const result = processInlineNode(child, newText, entities, newOffset)
        newText = result.text
        newOffset = result.currentOffset
      }
      break
    }

    // 代码块 ```code```
    case 'code': {
      // 确保代码块前后有空行，提升 Telegram 显示效果
      const needsLeadingNewline = newText.length > 0 && !newText.endsWith('\n')
      if (needsLeadingNewline) {
        newText += '\n'
        newOffset += 1
      }
      
      const start = newOffset
      newText += node.value
      const length = utf16Length(node.value)
      entities.push({
        type: 'pre',
        offset: start,
        length,
        language: node.lang || undefined
      })
      newOffset += length
      
      // 代码块后添加换行
      newText += '\n'
      newOffset += 1
      
      break
    }

    // 引用块 > text
    case 'blockquote': {
      const content = toString(node)
      const start = newOffset
      newText += content
      const length = utf16Length(content)
      entities.push({ type: 'blockquote', offset: start, length })
      newOffset += length
      break
    }

    // 标题 # Heading -> 转换为粗体
    case 'heading': {
      const content = toString(node)
      const start = newOffset
      newText += content
      const length = utf16Length(content)
      entities.push({ type: 'bold', offset: start, length })
      newOffset += length
      break
    }

    // 分割线 ---
    case 'thematicBreak': {
      const separator = '───'
      newText += separator
      newOffset += utf16Length(separator)
      break
    }

    // 列表
    case 'list': {
      for (const item of node.children) {
        // 处理列表项前缀
        const prefix = item.checked === true ? '[x] ' :
                      item.checked === false ? '[ ] ' : '- '
        newText += prefix
        newOffset += utf16Length(prefix)

        // 处理列表项内容
        for (const child of item.children) {
          const result = processBlockNode(child as BlockContent, newText, entities, newOffset)
          newText = result.text
          newOffset = result.currentOffset
        }
      }
      break
    }

    // 表格 (GFM) - 转换为等宽文本
    case 'table': {
      const tableText = formatTable(node)
      const start = newOffset
      newText += tableText
      const length = utf16Length(tableText)
      entities.push({ type: 'pre', offset: start, length })
      newOffset += length
      break
    }
  }

  return { text: newText, currentOffset: newOffset }
}

/**
 * 从 mdast 树中提取纯文本和 entities
 */
function extractEntitiesFromTree(tree: Root): MarkdownConvertResult {
  let text = ''
  const entities: TelegramEntity[] = []
  let currentOffset = 0

  // Process all children (block-level elements like paragraphs, headings, code blocks)
  for (let i = 0; i < tree.children.length; i++) {
    const node = tree.children[i]
    const isLastNode = i === tree.children.length - 1

    // Process the block node
    const result = processBlockNode(node as BlockContent, text, entities, currentOffset)
    text = result.text
    currentOffset = result.currentOffset

    // Add newline between block elements (except after last one)
    if (!isLastNode && needsSeparator(node)) {
      text += '\n'
      currentOffset += 1
    }
  }

  // 清理多余换行
  text = text.trim()

  return { text, entities }
}

/**
 * 格式化表格为等宽文本
 */
function formatTable(table: Table): string {
  // 提取表格数据
  const rows: string[][] = []
  
  for (const row of table.children) {
    const cells: string[] = []
    for (const cell of row.children) {
      cells.push(toString(cell))
    }
    rows.push(cells)
  }
  
  if (rows.length === 0) return ''
  
  // 计算每列最大宽度
  const colCount = Math.max(...rows.map(r => r.length))
  const colWidths: number[] = new Array(colCount).fill(0)
  
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i], stringWidth(row[i]))
    }
  }
  
  // 添加间距
  for (let i = 0; i < colWidths.length; i++) {
    colWidths[i] += 2
  }
  
  // 构建格式化表格
  const formattedRows: string[] = []
  
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    const paddedCells: string[] = []
    
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] || ''
      const targetWidth = colWidths[i]
      const currentWidth = stringWidth(cell)
      const padding = targetWidth - currentWidth
      
      // 左对齐填充
      paddedCells.push(cell + ' '.repeat(Math.max(0, padding)))
    }
    
    formattedRows.push(paddedCells.join('').trimEnd())
    
    // 添加分隔线（标题后）
    if (rowIndex === 0 && rows.length > 1) {
      const separator = colWidths.map(w => '-'.repeat(w - 2)).join('-+-')
      formattedRows.push(separator)
    }
  }
  
  return formattedRows.join('\n')
}

/**
 * 将长文本和 entities 分割成多个块（符合 Telegram 4096 限制）
 * 
 * @param text 完整文本
 * @param entities Entities 数组
 * @param maxLength 最大 UTF-16 长度（默认 4096）
 * @returns 分割后的结果数组
 */
export function splitEntities(
  text: string, 
  entities: TelegramEntity[], 
  maxLength: number = 4096
): Array<{ text: string; entities: TelegramEntity[] }> {
  const totalLength = utf16Length(text)
  
  if (totalLength <= maxLength) {
    return [{ text, entities }]
  }
  
  // 构建 UTF-16 偏移表
  const utf16Offsets: number[] = []
  let utf16Pos = 0
  for (const char of text) {
    utf16Offsets.push(utf16Pos)
    utf16Pos += char.codePointAt(0)! > 0xFFFF ? 2 : 1
  }
  utf16Offsets.push(utf16Pos)
  
  const chunks: Array<{ text: string; entities: TelegramEntity[] }> = []
  let chunkStart = 0
  
  while (chunkStart < text.length) {
    const chunkUtf16Start = utf16Offsets[chunkStart]
    const chunkUtf16End = Math.min(chunkUtf16Start + maxLength, totalLength)
    
    // 找到对应的字节位置
    let chunkEnd = chunkStart
    for (let i = chunkStart; i <= text.length; i++) {
      if (utf16Offsets[i] >= chunkUtf16End) {
        chunkEnd = i
        break
      }
    }
    
    // 提取文本
    const chunkText = text.slice(chunkStart, chunkEnd)
    
    // 调整 entities
    const chunkEntities: TelegramEntity[] = []
    for (const entity of entities) {
      const entityEnd = entity.offset + entity.length
      
      // 检查重叠
      if (entityEnd <= chunkUtf16Start || entity.offset >= chunkUtf16End) {
        continue // 无重叠
      }
      
      // 裁剪到块边界
      const clippedStart = Math.max(entity.offset, chunkUtf16Start)
      const clippedEnd = Math.min(entityEnd, chunkUtf16End)
      const clippedLength = clippedEnd - clippedStart
      
      if (clippedLength > 0) {
        chunkEntities.push({
          ...entity,
          offset: clippedStart - chunkUtf16Start,
          length: clippedLength
        })
      }
    }
    
    chunks.push({ text: chunkText, entities: chunkEntities })
    chunkStart = chunkEnd
  }
  
  return chunks
}
