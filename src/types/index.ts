/**
 * Universal IM Bridge for OpenCode
 * 
 * Provides bidirectional communication between OpenCode sessions and various IM platforms.
 * Supports: Telegram, Slack, Discord, and custom adapters.
 */

/**
 * Base message types
 */
export interface IMUser {
  id: string
  name: string
  username?: string
}

export interface IMMessage {
  id: string
  user: IMUser
  text: string
  timestamp: Date
  raw: unknown // Platform-specific raw data
}

export interface IMCallbackQuery {
  id: string
  user: IMUser
  data: string
  messageId: string
  raw: unknown
}

export interface IMButton {
  text: string
  callbackData: string
  url?: string
}

export interface IMKeyboard {
  inline: IMButton[][]
}

/**
 * Telegram Entity 类型（用于 entities 模式发送）
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
  keyboard?: IMKeyboard
  parseMode?: "markdown" | "html" | "plain" | "entities"
  /**
   * 当 parseMode 为 "entities" 时使用
   * 绕过 parse_mode，直接发送 text + entities
   */
  entities?: TelegramEntity[]
}

/**
 * OpenCode event types
 */
export interface QuestionInfo {
  id: string
  sessionId: string
  questions: Array<{
    header: string
    question: string
    options: Array<{
      label: string
      description: string
    }>
    multiple?: boolean
  }>
}

export interface PermissionInfo {
  id: string
  sessionId: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
}

/**
 * Session information from OpenCode
 */
export interface SessionInfo {
  id: string
  title?: string
  time?: {
    created?: string
    updated?: string
  }
}

/**
 * Adapter interface - Implement this to add support for a new IM platform
 */
export interface IMAdapter {
  readonly name: string
  readonly version: string
  
  /**
   * Initialize the adapter
   */
  initialize(config: unknown): Promise<void>
  
  /**
   * Send a message to the IM platform
   */
  sendMessage(message: IMOutgoingMessage): Promise<{ messageId: string }>
  
  /**
   * Edit an existing message
   */
  editMessage?(messageId: string, message: IMOutgoingMessage): Promise<void>
  
  /**
   * Delete a message
   */
  deleteMessage?(messageId: string): Promise<void>

  /**
   * Send a photo/image
   */
  sendPhoto?(imagePath: string, caption?: string): Promise<{ messageId: string }>

  /**
   * Set up message handler for incoming messages
   */
  onMessage(handler: (message: IMMessage) => void): void
  
  /**
   * Set up callback handler for button clicks
   */
  onCallback(handler: (callback: IMCallbackQuery) => void): void
  
  /**
   * Start receiving updates (polling or webhook)
   */
  start(): Promise<void>
  
  /**
   * Stop the adapter
   */
  stop(): Promise<void>
}

/**
 * Bridge configuration
 */
export interface BridgeConfig {
  /** Admin user IDs who can control the bridge */
  adminUsers?: string[]
  
  /** Allowed chat/group IDs (empty = allow all) */
  allowedChats?: string[]
  
  /** Message templates */
  templates?: {
    /** Question notification template */
    question?: (info: QuestionInfo) => string
    /** Permission request template */
    permission?: (info: PermissionInfo) => string
    /** Help message template */
    help?: () => string
  }

  /** Feature flags */
  features?: {
    /** Enable question notifications */
    questions?: boolean
    /** Enable permission notifications */
    permissions?: boolean
    /** Enable direct messaging to sessions */
    directMessaging?: boolean
  }
}

/**
 * Adapter constructor type
 */
export type AdapterConstructor = new () => IMAdapter

/**
 * Platform-specific configurations
 */
export interface TelegramConfig {
  botToken: string
  chatId: string
  webhookUrl?: string
  webhookPort?: number
}

export interface SlackConfig {
  botToken: string
  signingSecret: string
  channelId: string
  webhookUrl?: string
  port?: number
}

export interface DiscordConfig {
  botToken: string
  channelId: string
  guildId?: string
}

export type PlatformConfig = TelegramConfig | SlackConfig | DiscordConfig

/**
 * Plugin options
 */
export interface IMBridgeOptions {
  /** Platform type */
  platform: "telegram" | "slack" | "discord" | "custom"
  
  /** Platform-specific configuration */
  platformConfig: PlatformConfig
  
  /** Bridge behavior configuration */
  bridgeConfig?: BridgeConfig
  
  /** Custom adapter (when platform = "custom") */
  customAdapter?: AdapterConstructor
  
  /** Auto-start the bridge on OpenCode startup (default: true) */
  autoStart?: boolean
}
