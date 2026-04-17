/**
 * Check if text already contains HTML tags
 */
export function containsHtmlTags(text: string): boolean {
  // Match common HTML tags
  return /<\/?[a-z][\s\S]*?>/i.test(text)
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/**
 * Convert Markdown table to Telegram HTML table
 * Uses <table>, <tr>, <td>, <th> tags for proper alignment
 */
function markdownTableToTelegramHtml(tableText: string): string {
  const lines = tableText.trim().split('\n')
  if (lines.length < 2) return tableText

  // Parse rows
  const rows: string[][] = []
  for (const line of lines) {
    const cells = line
      .split('|')
      .map(cell => cell.trim())
      .filter(cell => cell.length > 0)
    if (cells.length > 0) {
      rows.push(cells)
    }
  }

  if (rows.length < 2) return tableText

  // Remove separator row (---|---|---)
  const dataRows = rows.filter((row, index) => {
    if (index === 0) return true // Keep header
    return !row.every(cell => /^[-:]+$/.test(cell)) // Filter out separator rows
  })

  if (dataRows.length < 1) return tableText

  // Build HTML table
  let html = '<table>'

  // Header row
  html += '<tr>'
  const headerRow = dataRows[0]
  for (const cell of headerRow) {
    html += `<th><b>${escapeHtml(cell)}</b></th>`
  }
  html += '</tr>'

  // Data rows
  for (let i = 1; i < dataRows.length; i++) {
    html += '<tr>'
    const row = dataRows[i]
    for (const cell of row) {
      html += `<td>${escapeHtml(cell)}</td>`
    }
    html += '</tr>'
  }

  html += '</table>'
  return html
}

/**
 * Part types for building the output
 */
type Part = 
  | { type: 'text'; content: string }
  | { type: 'codeBlock'; content: string }
  | { type: 'inlineCode'; content: string }
  | { type: 'table'; content: string }

/**
 * Convert Markdown to Telegram HTML subset
 * Telegram supports: <b>, <i>, <u>, <s>, <a>, <code>, <pre>
 */
export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return ""
  
  // Build a list of parts to process
  const parts: Part[] = []
  let remaining = markdown
  
  // Process tables first (they span multiple lines)
  const tablePattern = /(\|[^\n]+\|\n\|[-:|\s]+\|\n(?:\|[^\n]+\|\n?)+)/g
  let tableMatch
  let lastTableIndex = 0
  
  while ((tableMatch = tablePattern.exec(markdown)) !== null) {
    // Add text before table
    if (tableMatch.index > lastTableIndex) {
      parts.push({ type: 'text', content: markdown.slice(lastTableIndex, tableMatch.index) })
    }
    // Add table
    parts.push({ type: 'table', content: markdownTableToTelegramHtml(tableMatch[0]) })
    lastTableIndex = tableMatch.index + tableMatch[0].length
  }
  
  // Add remaining text after last table
  if (lastTableIndex < markdown.length) {
    remaining = markdown.slice(lastTableIndex)
  } else {
    remaining = ""
  }
  
  // If no tables found, process the whole text
  if (parts.length === 0) {
    remaining = markdown
  }
  
  // Process remaining text for code blocks, inline code, and markdown
  if (remaining) {
    const textParts = processTextParts(remaining)
    parts.push(...textParts)
  }
  
  // Build final HTML
  let html = ""
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        html += processMarkdown(part.content)
        break
      case 'codeBlock':
      case 'inlineCode':
      case 'table':
        html += part.content
        break
    }
  }
  
  return html.trim()
}

/**
 * Process text to extract code blocks and inline code
 * Uses a robust parser that correctly handles nested code blocks in AI responses
 */
function processTextParts(text: string): Part[] {
  const parts: Part[] = []
  const lines = text.split('\n')
  let i = 0
  let inCodeBlock = false
  let codeBlockContent: string[] = []
  let textBuffer: string[] = []
  
  while (i < lines.length) {
    const line = lines[i]
    const codeBlockMatch = line.match(/^```(\w+)?$/)
    
    if (codeBlockMatch && !inCodeBlock) {
      // Start of code block - flush text buffer first
      if (textBuffer.length > 0) {
        const textContent = textBuffer.join('\n')
        if (textContent) {
          parts.push(...processInlineCode(textContent))
        }
        textBuffer = []
      }
      inCodeBlock = true
      codeBlockContent = []
    } else if (line === '```' && inCodeBlock) {
      // End of code block - add the collected code
      const code = codeBlockContent.join('\n')
      const escapedCode = escapeHtml(code)
      parts.push({ type: 'codeBlock', content: `<pre><code>${escapedCode}</code></pre>` })
      inCodeBlock = false
      codeBlockContent = []
    } else if (inCodeBlock) {
      // Inside code block - collect as-is
      codeBlockContent.push(line)
    } else {
      // Outside code block - add to text buffer
      textBuffer.push(line)
    }
    
    i++
  }
  
  // Handle unclosed code block (treat remaining as code)
  if (inCodeBlock && codeBlockContent.length > 0) {
    const code = codeBlockContent.join('\n')
    const escapedCode = escapeHtml(code)
    parts.push({ type: 'codeBlock', content: `<pre><code>${escapedCode}</code></pre>` })
  }
  
  // Flush remaining text buffer
  if (textBuffer.length > 0) {
    const textContent = textBuffer.join('\n')
    if (textContent) {
      parts.push(...processInlineCode(textContent))
    }
  }
  
  // If no parts found, process entire text for inline code
  if (parts.length === 0) {
    parts.push(...processInlineCode(text))
  }
  
  return parts
}

/**
 * Process text to extract inline code
 */
function processInlineCode(text: string): Part[] {
  const parts: Part[] = []
  const inlineCodePattern = /`([^`]+)`/g
  let match
  let lastIndex = 0
  
  while ((match = inlineCodePattern.exec(text)) !== null) {
    // Add text before inline code
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: text.slice(lastIndex, match.index) })
    }
    
    // Add inline code (already escaped and wrapped)
    const code = match[1]
    const escapedCode = escapeHtml(code)
    parts.push({ type: 'inlineCode', content: `<code>${escapedCode}</code>` })
    
    lastIndex = match.index + match[0].length
  }
  
  // Add remaining text after last inline code
  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIndex) })
  }
  
  // If no inline code found, return entire text as text part
  if (parts.length === 0) {
    parts.push({ type: 'text', content: text })
  }
  
  return parts
}

/**
 * Process Markdown formatting (excluding code blocks and inline code)
 */
function processMarkdown(text: string): string {
  // Escape HTML first (except our generated tags which are already safe)
  let html = escapeHtml(text)
  
  // Convert Markdown to HTML
  // Bold: **text** or __text__
  html = html.replace(/\*\*([^\*]+)\*\*/g, "<b>$1</b>")
  html = html.replace(/__([^_]+)__/g, "<b>$1</b>")
  
  // Italic: *text* or _text_
  html = html.replace(/\*([^\*]+)\*/g, "<i>$1</i>")
  html = html.replace(/_([^_]+)_/g, "<i>$1</i>")
  
  // Strikethrough: ~~text~~
  html = html.replace(/~~([^~]+)~~/g, "<s>$1</s>")
  
  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  
  // Headers: ### text
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
  
  // Blockquote: > text
  html = html.replace(/^>\s+(.+)$/gm, "<i>$1</i>")
  
  return html
}