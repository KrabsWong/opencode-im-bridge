import type { 
  IMAdapter, 
  IMMessage, 
  IMCallbackQuery, 
  IMOutgoingMessage,
  TelegramMessage, 
  TelegramCallbackQuery, 
  TelegramUpdate,
  TelegramEntity
} from '../types/index.js'
import { markdownToEntities } from '../core/markdown-entities.js'

export class TelegramAdapter implements IMAdapter {
  readonly name = 'telegram'
  readonly version = '1.0.0'

  private botToken: string
  private baseUrl: string
  private offset: number = 0
  private running: boolean = false
  private messageHandlers: Array<(message: IMMessage) => void> = []
  private callbackHandlers: Array<(callback: IMCallbackQuery) => void> = []
  private readonly TIMEOUT_MS = 120000 // 120秒超时

  constructor(botToken?: string) {
    this.botToken = botToken || ''
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`
  }

  /**
   * 带超时的 fetch 请求
   */
  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      })
      clearTimeout(timeoutId)
      return response
    } catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.TIMEOUT_MS}ms`)
      }
      throw error
    }
  }

  /**
   * Initialize the adapter
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    if (config.botToken) {
      this.botToken = config.botToken as string
      this.baseUrl = `https://api.telegram.org/bot${this.botToken}`
    }
  }

  /**
   * Send a message to Telegram
   * Supports entities mode for precise Markdown formatting
   */
  async sendMessage(message: IMOutgoingMessage): Promise<{ messageId: string }> {
    const url = `${this.baseUrl}/sendMessage`

    // Convert markdown to entities if parseMode is 'entities'
    let text = message.text
    let entities: TelegramEntity[] | undefined
    let parseMode: string | undefined

    if (message.parseMode === 'entities') {
      const result = markdownToEntities(message.text)
      text = result.text
      entities = result.entities
      parseMode = undefined // Don't use parse_mode when using entities
    } else {
      parseMode = message.parseMode
    }

    const body: any = {
      chat_id: message.chatId,
      text: text
    }

    if (parseMode) {
      body.parse_mode = parseMode
    }

    if (entities && entities.length > 0) {
      body.entities = entities
    }

    if (message.replyMarkup) {
      body.reply_markup = this.convertKeyboard(message.replyMarkup)
    }

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Telegram API error: ${error}`)
    }

    const data = await response.json() as { result: { message_id: number } }
    return { messageId: data.result.message_id.toString() }
  }

  /**
   * Edit an existing message
   */
  async editMessage(messageId: string, message: Partial<IMOutgoingMessage>): Promise<void> {
    if (!message.chatId) {
      throw new Error('chatId is required to edit message')
    }

    const url = `${this.baseUrl}/editMessageText`

    // Convert markdown to entities if parseMode is 'entities'
    let text = message.text
    let entities: TelegramEntity[] | undefined
    let parseMode: string | undefined

    if (message.parseMode === 'entities') {
      const result = markdownToEntities(message.text || '')
      text = result.text
      entities = result.entities
      parseMode = undefined
    } else {
      parseMode = message.parseMode
    }

    const body: any = {
      chat_id: message.chatId,
      message_id: parseInt(messageId),
      text: text
    }

    if (parseMode) {
      body.parse_mode = parseMode
    }

    if (entities && entities.length > 0) {
      body.entities = entities
    }

    if (message.replyMarkup) {
      body.reply_markup = this.convertKeyboard(message.replyMarkup)
    }

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Telegram API error: ${error}`)
    }
  }

  /**
   * Convert IM keyboard to Telegram format
   */
  private convertKeyboard(keyboard: any): any {
    if (!keyboard || !keyboard.inline) {
      return undefined
    }

    return {
      inline_keyboard: keyboard.inline.map((row: any[]) =>
        row.map((btn: any) => {
          const button: any = {
            text: btn.text
          }
          if (btn.callbackData) {
            button.callback_data = btn.callbackData
          }
          if (btn.url) {
            button.url = btn.url
          }
          return button
        })
      )
    }
  }

  /**
   * Set up message handler
   */
  onMessage(handler: (message: IMMessage) => void): void {
    this.messageHandlers.push(handler)
  }

  /**
   * Set up callback handler
   */
  onCallback(handler: (callback: IMCallbackQuery) => void): void {
    this.callbackHandlers.push(handler)
  }

  /**
   * Start receiving updates
   */
  async start(): Promise<void> {
    this.running = true
    console.log('Telegram adapter started polling...')
    this.poll()
  }

  /**
   * Stop the adapter
   */
  async stop(): Promise<void> {
    this.running = false
    console.log('Telegram adapter stopped')
  }

  /**
   * Poll for updates
   */
  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.getUpdates()
        for (const update of updates) {
          this.handleUpdate(update)
        }
      } catch (err) {
        console.error('Error polling updates:', err)
        await sleep(5000)
      }
    }
  }

  /**
   * Get updates from Telegram
   */
  private async getUpdates(): Promise<TelegramUpdate[]> {
    const url = `${this.baseUrl}/getUpdates`

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset: this.offset,
        limit: 100,
        timeout: 30
      })
    })

    if (!response.ok) {
      throw new Error(`Failed to get updates: ${response.statusText}`)
    }

    const data = await response.json() as { 
      ok: boolean 
      description?: string 
      result: TelegramUpdate[] 
    }

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`)
    }

    const updates = data.result

    if (updates.length > 0) {
      this.offset = updates[updates.length - 1].update_id + 1
    }

    return updates
  }

  /**
   * Handle incoming update
   */
  private handleUpdate(update: TelegramUpdate): void {
    if (update.message) {
      const message = this.convertToIMMessage(update.message)
      this.messageHandlers.forEach(handler => handler(message))
    }

    if (update.callback_query) {
      const callback = this.convertToIMCallback(update.callback_query)
      this.callbackHandlers.forEach(handler => handler(callback))
    }
  }

  /**
   * Convert Telegram message to IM message
   */
  private convertToIMMessage(tgMsg: TelegramMessage): IMMessage {
    return {
      id: tgMsg.message_id.toString(),
      user: {
        id: tgMsg.from.id.toString(),
        name: tgMsg.from.first_name,
        username: tgMsg.from.username
      },
      text: tgMsg.text || '',
      chatId: tgMsg.chat.id,
      timestamp: new Date(tgMsg.date * 1000),
      raw: tgMsg
    }
  }

  /**
   * Convert Telegram callback to IM callback
   */
  private convertToIMCallback(tgCallback: TelegramCallbackQuery): IMCallbackQuery {
    return {
      id: tgCallback.id,
      user: {
        id: tgCallback.from.id.toString(),
        name: tgCallback.from.first_name,
        username: tgCallback.from.username
      },
      data: tgCallback.data,
      messageId: tgCallback.message?.message_id.toString(),
      chatId: tgCallback.message?.chat.id || tgCallback.from.id,
      raw: tgCallback
    }
  }

  /**
   * Answer callback query
   */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const url = `${this.baseUrl}/answerCallbackQuery`

    const body: any = {
      callback_query_id: callbackQueryId
    }

    if (text) {
      body.text = text
    }

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Telegram API error: ${error}`)
    }
  }

  /**
   * Get bot info
   */
  async getMe(): Promise<{ id: number; username: string; first_name: string }> {
    const url = `${this.baseUrl}/getMe`

    const response = await this.fetchWithTimeout(url, {
      method: 'GET'
    })

    if (!response.ok) {
      throw new Error(`Failed to get bot info: ${response.statusText}`)
    }

    const data = await response.json() as {
      ok: boolean
      description?: string
      result: { id: number; username: string; first_name: string }
    }

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`)
    }

    return data.result
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
