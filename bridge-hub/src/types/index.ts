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

// Discord Thread 上下文（用于 Thread 级实例选择）
export interface ChatContext {
  chatId: number
  selectedInstanceId?: string
  selectedSessionId?: string
  lastActivity: number
}

// 最近使用的实例+会话组合
export interface RecentCombo {
  instanceId: string      // 实例 ID（工作目录路径）
  instanceName: string    // 实例显示名称（目录名）
  sessionId: string       // 会话 ID
  sessionTitle: string    // 会话标题
  lastUsedAt: number      // 最后使用时间戳
  useCount: number        // 使用次数（用于排序）
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
  replyToMessageId?: string  // 引用/回复的消息 ID
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
   * Delete a message
   */
  deleteMessage?(chatId: number, messageId: string): Promise<void>

  /**
   * Get the instance ID associated with a specific chat/channel/thread
   * Used for auto-routing messages in platforms like Discord where
   * each chat/thread maps to a specific instance
   * 
   * @param chatId The chat/channel/thread ID
   * @returns The instance ID if determined by the adapter, undefined otherwise
   */
  getInstanceIdForChat?(chatId: number): string | undefined

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
