import type {
  IMAdapter,
  IMMessage,
  IMCallbackQuery,
  IMOutgoingMessage,
  TelegramConfig
} from "../types/index.js"
import { IMBridgeLogger } from "../core/bridge.js"
import { marked } from "marked"

// Adapter-level logger
const adapterLogger = new IMBridgeLogger(".opencode/im-bridge-adapter.log")

/**
 * Convert Markdown table to Telegram-compatible <pre> format with aligned columns
 */
function markdownTableToTelegramPre(tableText: string): string {
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
  
  // Calculate column widths
  const colCount = Math.max(...dataRows.map(row => row.length))
  const colWidths: number[] = new Array(colCount).fill(0)
  
  for (const row of dataRows) {
    for (let i = 0; i < row.length; i++) {
      // Calculate display width (simple: length for ASCII, double for CJK)
      const displayWidth = [...row[i]].reduce((acc, char) => {
        // CJK characters are roughly 2x width
        return acc + (char.charCodeAt(0) > 127 ? 2 : 1)
      }, 0)
      colWidths[i] = Math.max(colWidths[i], displayWidth)
    }
  }
  
  // Pad columns and build table
  const formattedRows: string[] = []
  
  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
    const row = dataRows[rowIndex]
    const paddedCells: string[] = []
    
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] || ''
      const width = colWidths[i]
      
      // Calculate padding needed
      const cellWidth = [...cell].reduce((acc, char) => {
        return acc + (char.charCodeAt(0) > 127 ? 2 : 1)
      }, 0)
      const padding = width - cellWidth
      
      paddedCells.push(cell + ' '.repeat(Math.max(0, padding)))
    }
    
    formattedRows.push(paddedCells.join(' │ '))
    
    // Add separator after header
    if (rowIndex === 0) {
      const separator = colWidths.map(w => '─'.repeat(w)).join('─┼─')
      formattedRows.push(separator)
    }
  }
  
  return `<pre>${formattedRows.join('\n')}</pre>`
}

/**
 * Custom marked renderer for Telegram HTML subset
 * Telegram supports: <b>, <i>, <u>, <s>, <a>, <code>, <pre>
 */
function createTelegramRenderer() {
  return {
    // Space between tokens
    space(): string {
      return ''
    },
    
    // Text styling
    strong(text: string): string {
      return `<b>${text}</b>`
    },
    
    em(text: string): string {
      return `<i>${text}</i>`
    },
    
    del(text: string): string {
      return `<s>${text}</s>`
    },
    
    // Code
    code(code: string, language?: string): string {
      // Escape HTML in code
      const escapedCode = code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
      return `<pre><code>${escapedCode}</code></pre>`
    },
    
    codespan(code: string): string {
      // Escape HTML in inline code
      const escapedCode = code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
      return `<code>${escapedCode}</code>`
    },
    
    // Links
    link(href: string, title: string | null | undefined, text: string): string {
      return `<a href="${href}">${text}</a>`
    },
    
    // Paragraphs - just return text without <p> tags
    paragraph(text: string): string {
      return text + '\n\n'
    },
    
    // Headings - use bold
    heading(text: string, level: number): string {
      return `<b>${text}</b>\n\n`
    },
    
    // Blockquote - use italic
    blockquote(quote: string): string {
      return `<i>${quote.trim()}</i>\n\n`
    },
    
    // Lists - Telegram doesn't support HTML lists, use text format
    list(body: string, ordered: boolean): string {
      return body + '\n'
    },
    
    listitem(text: string): string {
      return `• ${text.trim()}\n`
    },
    
    // Horizontal rule
    hr(): string {
      return '─────────────────\n\n'
    },
    
    // Line break
    br(): string {
      return '\n'
    },
    
    // Tables - use custom format
    table(header: string, body: string): string {
      // Extract table content and convert to aligned format
      return header + body
    },
    
    tablerow(content: string): string {
      return content
    },
    
    tablecell(content: string, flags: { header: boolean; align: 'center' | 'left' | 'right' | null }): string {
      return content + ' | '
    }
  }
}

/**
 * Check if text already contains HTML tags
 */
function containsHtmlTags(text: string): boolean {
  // Match common HTML tags
  return /<\/?[a-z][\s\S]*?>/i.test(text)
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/**
 * Convert Markdown to Telegram HTML subset using marked library
 * If input already contains HTML tags, preserve them
 */
function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return ""
  
  adapterLogger.debug(`[markdownToTelegramHtml] Input: ${markdown.slice(0, 100)}...`)
  adapterLogger.debug(`[markdownToTelegramHtml] Contains HTML tags: ${containsHtmlTags(markdown)}`)
  
  // If text already contains HTML tags, assume it's pre-formatted HTML
  // Just escape any raw < or > that are not part of tags
  if (containsHtmlTags(markdown)) {
    adapterLogger.debug(`[markdownToTelegramHtml] Skipping marked, preserving existing HTML`)
    // Protect existing HTML tags while escaping raw < >
    const protectedTags: string[] = []
    let html = markdown.replace(/<\/?[a-z][^>]*?>/gi, (match) => {
      const placeholder = `\x00HTMLTAG${protectedTags.length}\x00`
      protectedTags.push(match)
      return placeholder
    })
    
    // Escape remaining < > 
    html = escapeHtml(html)
    
    // Restore HTML tags
    protectedTags.forEach((tag, i) => {
      html = html.replace(`\x00HTMLTAG${i}\x00`, tag)
    })
    
    return html
  }
  
  // Extract tables first (marked doesn't have good table rendering for Telegram)
  let html = markdown
  const tables: string[] = []
  
  const tablePattern = /(\|[^\n]+\|\n\|[-:|\s]+\|\n(?:\|[^\n]+\|\n?)+)/g
  html = html.replace(tablePattern, (match) => {
    const placeholder = `\x00TABLE${tables.length}\x00`
    tables.push(markdownTableToTelegramPre(match))
    return placeholder
  })
  
  // Configure marked with custom renderer
  const renderer = createTelegramRenderer()
  
  marked.use({ 
    renderer: renderer as any,
    gfm: true,
    breaks: true
  })
  
  // Parse markdown
  let result: string = marked.parse(html) as string
  
  // Restore tables
  tables.forEach((table, i) => {
    result = result.replace(`\x00TABLE${i}\x00`, table)
  })
  
  // Clean up extra whitespace
  result = result.trim()
  
  return result
}

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: {
      id: number
      first_name: string
      username?: string
    }
    chat: {
      id: number
    }
    text?: string
    date: number
  }
  callback_query?: {
    id: string
    from: {
      id: number
      first_name: string
      username?: string
    }
    message?: {
      message_id: number
    }
    data?: string
  }
}

interface TelegramResponse {
  ok: boolean
  result?: {
    message_id: number
  }
  description?: string
}

/**
 * Telegram Bot Adapter for OpenCode IM Bridge
 * 
 * Supports both Long Polling and Webhook modes
 */
export class TelegramAdapter implements IMAdapter {
  readonly name = "telegram"
  readonly version = "1.0.0"
  
  private config!: TelegramConfig
  private messageHandler?: (message: IMMessage) => void
  private callbackHandler?: (callback: IMCallbackQuery) => void
  private pollingActive = false
  private offset = 0
  private server?: ReturnType<typeof Bun.serve>
  private apiUrl = ""
  
  /**
   * Initialize the adapter with configuration
   */
  async initialize(config: Record<string, unknown> | unknown): Promise<void> {
    this.config = config as TelegramConfig
    this.apiUrl = `https://api.telegram.org/bot${this.config.botToken}`
    
    // Validate configuration
    if (!this.config.botToken) {
      throw new Error("Telegram adapter: botToken is required")
    }
    if (!this.config.chatId) {
      throw new Error("Telegram adapter: chatId is required")
    }
    
    // Verify bot token works
    const me = await this.makeRequest<TelegramResponse>("getMe")
    if (!me.ok) {
      throw new Error(`Telegram adapter: Invalid bot token - ${me.description}`)
    }
    
    adapterLogger.info(`[TelegramAdapter] Initialized as @${me.result}`)
  }
  
  /**
   * Start receiving updates (polling or webhook)
   */
  async start(): Promise<void> {
    if (this.config.webhookUrl) {
      await this.startWebhook()
    } else {
      await this.startPolling()
    }
  }
  
  /**
   * Stop the adapter
   */
  async stop(): Promise<void> {
    this.pollingActive = false
    
    if (this.server) {
      this.server.stop()
      this.server = undefined
    }
    
    // Remove webhook if set
    if (this.config.webhookUrl) {
      await this.makeRequest<TelegramResponse>("deleteWebhook")
    }
    
    adapterLogger.info("[TelegramAdapter] Stopped")
  }
  
  /**
   * Send a message to Telegram
   */
  async sendMessage(message: IMOutgoingMessage): Promise<{ messageId: string }> {
    adapterLogger.debug(`[TelegramAdapter] sendMessage called with text length: ${message.text.length}`)
    
    // Convert Markdown to HTML if parseMode is html
    let text = message.text
    if (message.parseMode === "html") {
      text = markdownToTelegramHtml(text)
    }
    
    const body: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text: text.substring(0, 4096), // Telegram limit
    }
    
    // Parse mode
    if (message.parseMode === "markdown") {
      body.parse_mode = "MarkdownV2"
    } else if (message.parseMode === "html") {
      body.parse_mode = "HTML"
    }
    
    // Keyboard
    if (message.keyboard?.inline) {
      body.reply_markup = {
        inline_keyboard: message.keyboard.inline.map((row) =>
          row.map((btn) => {
            const result: Record<string, string> = {
              text: btn.text,
              callback_data: btn.callbackData,
            }
            if (btn.url) {
              result.url = btn.url
              delete result.callback_data
            }
            return result
          })
        ),
      }
    }
    
    adapterLogger.debug(`[TelegramAdapter] Sending request`, { body })

    const res = await this.makeRequest<TelegramResponse>("sendMessage", body)

    adapterLogger.debug(`[TelegramAdapter] Response`, { res })
    
    if (!res.ok) {
      throw new Error(`Telegram API error: ${res.description}`)
    }
    
    return { messageId: String(res.result!.message_id) }
  }
  
  /**
   * Edit an existing message
   */
  async editMessage(messageId: string, message: IMOutgoingMessage): Promise<void> {
    // Convert Markdown to HTML if parseMode is html
    let text = message.text
    if (message.parseMode === "html") {
      text = markdownToTelegramHtml(text)
    }
    
    const body: Record<string, unknown> = {
      chat_id: this.config.chatId,
      message_id: parseInt(messageId, 10),
      text: text.substring(0, 4096),
    }
    
    if (message.parseMode === "markdown") {
      body.parse_mode = "MarkdownV2"
    } else if (message.parseMode === "html") {
      body.parse_mode = "HTML"
    }
    
    if (message.keyboard?.inline) {
      body.reply_markup = {
        inline_keyboard: message.keyboard.inline.map((row) =>
          row.map((btn) => ({
            text: btn.text,
            callback_data: btn.callbackData,
          }))
        ),
      }
    }
    
    const res = await this.makeRequest<TelegramResponse>("editMessageText", body)
    
    if (!res.ok) {
      throw new Error(`Failed to edit message: ${res.description}`)
    }
  }
  
  /**
   * Delete a message
   */
  async deleteMessage(messageId: string): Promise<void> {
    await this.makeRequest<TelegramResponse>("deleteMessage", {
      chat_id: this.config.chatId,
      message_id: parseInt(messageId, 10),
    })
  }

  /**
   * Send a photo/image to Telegram
   */
  async sendPhoto(imagePath: string, caption?: string): Promise<{ messageId: string }> {
    adapterLogger.info(`[TelegramAdapter] Sending photo: ${imagePath}`)

    try {
      // Read image file using Bun
      const file = Bun.file(imagePath)
      const exists = await file.exists()
      if (!exists) {
        throw new Error(`Image file not found: ${imagePath}`)
      }

      const imageBuffer = await file.arrayBuffer()
      const imageBlob = new Blob([imageBuffer], { type: 'image/png' })

      // Create FormData
      const formData = new FormData()
      formData.append('chat_id', this.config.chatId)
      formData.append('photo', imageBlob, 'architecture.png')
      if (caption) {
        formData.append('caption', caption)
        formData.append('parse_mode', 'HTML')
      }

      // Send request
      const url = `https://api.telegram.org/bot${this.config.botToken}/sendPhoto`
      const response = await fetch(url, {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Telegram API error: ${response.status} ${errorText}`)
      }

      const result = await response.json() as TelegramResponse
      if (!result.ok) {
        throw new Error(`Telegram API error: ${result.description}`)
      }

      adapterLogger.info(`[TelegramAdapter] Photo sent successfully`)
      return { messageId: String(result.result!.message_id) }
    } catch (error) {
      adapterLogger.error(`[TelegramAdapter] Failed to send photo:`, error)
      throw error
    }
  }
  
  /**
   * Set up message handler
   */
  onMessage(handler: (message: IMMessage) => void): void {
    this.messageHandler = handler
  }
  
  /**
   * Set up callback handler
   */
  onCallback(handler: (callback: IMCallbackQuery) => void): void {
    this.callbackHandler = handler
  }
  
  /**
   * Start long polling
   */
  private async startPolling(): Promise<void> {
    this.pollingActive = true
    
    // Clear any existing webhook
    await this.makeRequest<TelegramResponse>("deleteWebhook")
    
    adapterLogger.info("[TelegramAdapter] Starting long polling...")
    
    // Start polling loop in background
    this.pollLoop()
  }
  
  /**
   * Polling loop
   */
  private async pollLoop(): Promise<void> {
    let retryCount = 0
    const maxRetries = 5
    const baseDelay = 5000

    while (this.pollingActive) {
      try {
        const updates = await this.makeRequest<{ ok: boolean; result: TelegramUpdate[] }>(
          "getUpdates",
          {
            offset: this.offset,
            limit: 10,
            timeout: 30,
          }
        )

        if (updates.ok && updates.result.length > 0) {
          for (const update of updates.result) {
            this.offset = update.update_id + 1
            await this.processUpdate(update)
          }
        }
        // Reset retry count on success
        retryCount = 0
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)

        // Handle 409 Conflict - another instance is polling
        if (errorMsg.includes("409")) {
          retryCount++
          if (retryCount >= maxRetries) {
            adapterLogger.error("[TelegramAdapter] Too many conflicts, another bot instance may be running. Stopping polling.")
            this.pollingActive = false
            break
          }

          // Exponential backoff for conflicts
          const delay = baseDelay * Math.pow(2, retryCount - 1)
          adapterLogger.warn(`[TelegramAdapter] Conflict detected (attempt ${retryCount}/${maxRetries}), waiting ${delay}ms...`)
          await new Promise((r) => setTimeout(r, delay))

          // Try to reclaim by deleting webhook
          if (retryCount === 2) {
            adapterLogger.info("[TelegramAdapter] Trying to reclaim bot by deleting webhook...")
            await this.makeRequest<TelegramResponse>("deleteWebhook").catch(() => {})
          }
        } else {
          adapterLogger.error("[TelegramAdapter] Polling error:", error)
          await new Promise((r) => setTimeout(r, 5000))
        }
      }
    }
  }
  
  /**
   * Start webhook server
   */
  private async startWebhook(): Promise<void> {
    if (!this.config.webhookPort) {
      throw new Error("Telegram adapter: webhookPort is required for webhook mode")
    }
    
    // Set up webhook endpoint
    this.server = Bun.serve({
      port: this.config.webhookPort,
      fetch: async (req) => {
        if (req.method !== "POST") {
          return new Response("Method not allowed", { status: 405 })
        }
        
        try {
          const update = await req.json() as TelegramUpdate
          await this.processUpdate(update)
          return new Response("OK")
        } catch (error) {
          adapterLogger.error("[TelegramAdapter] Webhook error:", error)
          return new Response("Error", { status: 500 })
        }
      },
    })

    // Set webhook URL
    const webhookUrl = this.config.webhookUrl || `http://localhost:${this.config.webhookPort}`
    await this.makeRequest<TelegramResponse>("setWebhook", {
      url: webhookUrl,
    })

    adapterLogger.info(`[TelegramAdapter] Webhook server listening on port ${this.config.webhookPort}`)
  }
  
  /**
   * Process a Telegram update
   */
  private async processUpdate(update: TelegramUpdate): Promise<void> {
    // Handle messages
    if (update.message && this.messageHandler) {
      const msg = this.convertToIMMessage(update.message)
      if (msg) {
        this.messageHandler(msg)
      }
    }
    
    // Handle callback queries
    if (update.callback_query && this.callbackHandler) {
      const callback = this.convertToIMCallback(update.callback_query)
      if (callback) {
        this.callbackHandler(callback)
        
        // Answer the callback query
        await this.makeRequest<TelegramResponse>("answerCallbackQuery", {
          callback_query_id: update.callback_query.id,
        })
      }
    }
  }
  
  /**
   * Convert Telegram message to IMMessage
   */
  private convertToIMMessage(msg: TelegramUpdate["message"]): IMMessage | null {
    if (!msg || !msg.from || !msg.text) return null
    
    return {
      id: String(msg.message_id),
      user: {
        id: String(msg.from.id),
        name: msg.from.first_name,
        username: msg.from.username,
      },
      text: msg.text,
      timestamp: new Date(msg.date * 1000),
      raw: msg,
    }
  }
  
  /**
   * Convert Telegram callback to IMCallbackQuery
   */
  private convertToIMCallback(cb: TelegramUpdate["callback_query"]): IMCallbackQuery | null {
    if (!cb || !cb.from || !cb.data) return null
    
    return {
      id: cb.id,
      user: {
        id: String(cb.from.id),
        name: cb.from.first_name,
        username: cb.from.username,
      },
      data: cb.data,
      messageId: cb.message ? String(cb.message.message_id) : "",
      raw: cb,
    }
  }
  
  /**
   * Make API request to Telegram
   */
  private async makeRequest<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.apiUrl}/${method}`
    
    const options: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    }
    
    if (body) {
      options.body = JSON.stringify(body)
    }
    
    const res = await fetch(url, options)
    
    if (!res.ok) {
      throw new Error(`Telegram API error: ${res.status} ${res.statusText}`)
    }
    
    return res.json() as Promise<T>
  }
}

export default TelegramAdapter
