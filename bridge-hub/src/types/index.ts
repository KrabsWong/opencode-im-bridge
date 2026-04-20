// Bridge Hub Types

export interface ConnectedInstance {
  id: string
  workspace: string
  socket: any  // WebSocket from 'ws' library
  status: 'connected' | 'busy' | 'disconnected'
  lastPing: number
  capabilities: string[]
}

export interface UserContext {
  userId: string
  selectedInstanceId?: string
  selectedSessionId?: string
  lastActivity: number
}

export interface HubMessage {
  type: 'register' | 'unregister' | 'request' | 'response' | 'event' | 'ping' | 'pong' | 'error' | 'registered'
  requestId?: string
  data?: any
}

// Use WebSocket type from ws library
export type WebSocketType = WebSocket

export interface RegisterMessage {
  type: 'register'
  instanceId: string
  workspace: string
  authToken: string
  capabilities: string[]
}

// ============ IM Adapter Interface ============

export interface IMUser {
  id: string
  name: string
  username?: string
}

export interface IMMessage {
  id: string
  user: IMUser
  text: string
  chatId: number
  timestamp: Date
  raw: unknown
}

export interface IMCallbackQuery {
  id: string
  user: IMUser
  data: string
  messageId?: string
  chatId: number
  raw: unknown
}

/**
 * Telegram Entity 类型（用于 entities 模式发送）
 * 支持精确的 Markdown 格式控制
 */
export interface TelegramEntity {
  type: 'bold' | 'italic' | 'code' | 'pre' | 'text_link' | 'strikethrough' | 'blockquote' | 'underline' | 'spoiler'
  offset: number
  length: number
  url?: string
  language?: string
}

export interface IMOutgoingMessage {
  text: string
  chatId: number
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2' | 'entities'
  entities?: TelegramEntity[]
  replyMarkup?: IMKeyboard
}

export interface IMKeyboardButton {
  text: string
  callbackData?: string
  url?: string
}

export interface IMKeyboard {
  inline: IMKeyboardButton[][]
}

/**
 * IM Adapter Interface
 * All IM platform adapters must implement this interface
 */
export interface IMAdapter {
  readonly name: string
  readonly version: string
  
  /**
   * Initialize the adapter with configuration
   */
  initialize(config: Record<string, unknown>): Promise<void>
  
  /**
   * Send a message to the IM platform
   */
  sendMessage(message: IMOutgoingMessage): Promise<{ messageId: string }>
  
  /**
   * Edit an existing message
   */
  editMessage?(messageId: string, message: Partial<IMOutgoingMessage>): Promise<void>
  
  /**
   * Set up message handler for incoming messages
   */
  onMessage(handler: (message: IMMessage) => void): void
  
  /**
   * Set up callback handler for button clicks
   */
  onCallback(handler: (callback: IMCallbackQuery) => void): void
  
  /**
   * Start receiving updates
   */
  start(): Promise<void>
  
  /**
   * Stop the adapter
   */
  stop(): Promise<void>
}

// ============ Telegram Specific Types ============

export interface TelegramMessage {
  message_id: number
  from: {
    id: number
    first_name: string
    username?: string
  }
  chat: {
    id: number
    type: string
  }
  text?: string
  date: number
}

export interface TelegramCallbackQuery {
  id: string
  from: {
    id: number
    first_name: string
    username?: string
  }
  message?: {
    message_id: number
    chat: {
      id: number
    }
  }
  data: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface TelegramOutgoingMessage {
  chatId: number
  text: string
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2'
  replyMarkup?: any
}
