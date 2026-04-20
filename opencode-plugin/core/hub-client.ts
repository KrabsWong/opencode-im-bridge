import type { PluginInput } from "@opencode-ai/plugin"
import type { HubConfig, HubMessage, HubRequest } from "../types/index.js"
import { IMBridgeLogger } from "./logger.js"

/**
 * Hub Client - Connects to Bridge Hub as a WebSocket client
 * Replaces the old standalone mode where plugin directly connected to Telegram
 */
export class HubClient {
  private config: HubConfig
  private input: PluginInput
  private socket: WebSocket | null = null
  private logger: IMBridgeLogger
  private pendingRequests: Map<string, { resolve: (value: any) => void; reject: (reason?: any) => void }> = new Map()
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectDelay = 5000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private isConnecting = false

  constructor(config: HubConfig, input: PluginInput) {
    this.config = {
      instanceId: config.instanceId || this.generateInstanceId(),
      ...config
    }
    this.input = input
    this.logger = new IMBridgeLogger(".opencode/hub-client.log")
  }

  /**
   * Generate instance ID from current directory
   */
  private generateInstanceId(): string {
    const cwd = process.cwd()
    const parts = cwd.split('/')
    const lastDir = parts[parts.length - 1] || 'unknown'
    // Add a short hash of the full path to make it unique
    const hash = this.simpleHash(cwd).slice(0, 6)
    return `${lastDir}-${hash}`
  }

  /**
   * Simple hash function for string
   */
  private simpleHash(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(36)
  }

  /**
   * Generate intelligent title based on conversation messages
   */
  private generateSmartTitle(messages: any[]): string {
    this.logger.info(`[autotitle] Generating title from ${messages.length} messages`)

    if (messages.length === 0) {
      this.logger.warn('[autotitle] No messages found, using default title')
      return 'New Session'
    }

    // Log message details for debugging
    this.logger.info('[autotitle] Messages:', messages.map((m: any) => ({ role: m.role, content: m.content?.slice(0, 50) })))

    // Get first user message for context
    const firstUserMessage = messages.find((m: any) => m.role === 'user')?.content || ''
    this.logger.info(`[autotitle] First user message: "${firstUserMessage.slice(0, 100)}"`)

    // Extract key topics/keywords from all messages
    const allContent = messages
      .filter((m: any) => m.role === 'user' || m.role === 'assistant')
      .map((m: any) => m.content)
      .join(' ')

    // Try to extract main topic from first user message
    let title = this.extractMainTopic(firstUserMessage)
    this.logger.info(`[autotitle] Extracted from first message: "${title}"`)

    // If no clear topic found, try to extract from all content
    if (!title || title.length < 3) {
      title = this.extractMainTopic(allContent)
      this.logger.info(`[autotitle] Extracted from all content: "${title}"`)
    }

    // Fallback to first message preview
    if (!title || title.length < 3) {
      title = firstUserMessage.slice(0, 50) || allContent.slice(0, 50)
      this.logger.info(`[autotitle] Using first message preview: "${title}"`)
    }

    // Clean up title
    title = title
      .replace(/^[^\w\u4e00-\u9fa5]+/, '') // Remove leading non-word chars
      .replace(/[\n\r]+/g, ' ') // Replace newlines with space
      .trim()

    // Truncate if too long
    if (title.length > 50) {
      title = title.slice(0, 47) + '...'
    }

    const finalTitle = title || 'New Session'
    this.logger.info(`[autotitle] Final title: "${finalTitle}"`)

    return finalTitle
  }

  /**
   * Extract main topic from text content
   */
  private extractMainTopic(content: string): string {
    if (!content) return ''

    // Common task keywords to look for
    const taskPatterns = [
      // Development tasks
      /(?:implement|create|build|add|fix|update|refactor|optimize)\s+([\w\s-]+?)(?:\s+(?:for|in|to)\s+|$)/i,
      // Question patterns
      /(?:how\s+to|what\s+is|explain|help\s+(?:me\s+)?(?:with|understand))\s+([\w\s-]+?)(?:\?|$)/i,
      // Topic patterns
      /(?:about|regarding|concerning)\s+([\w\s-]+?)(?:\s+[,;]|$)/i,
      // File/Project patterns
      /(?:file|project|code|function|class|component)\s+(?:called|named)?\s*['"`]?([\w\s.-]+?)['"`]?(?:\s|$)/i,
      // Chinese patterns
      /(?:实现|创建|添加|修复|更新|优化|重构)\s*([\u4e00-\u9fa5\w\s-]+?)(?:\s*[,;，。]|$)/,
      /(?:关于|如何|什么是|解释|帮助)\s*([\u4e00-\u9fa5\w\s-]+?)(?:\?|$)/,
    ]

    for (const pattern of taskPatterns) {
      const match = content.match(pattern)
      if (match && match[1]) {
        const topic = match[1].trim()
        if (topic.length >= 3 && topic.length <= 50) {
          return topic
        }
      }
    }

    // Try to extract first sentence or phrase
    const firstSentence = content.split(/[.!?。！？]/)[0].trim()
    if (firstSentence.length >= 3 && firstSentence.length <= 50) {
      return firstSentence
    }

    return ''
  }

  /**
   * Connect to Bridge Hub
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.socket?.readyState === WebSocket.OPEN) {
      return
    }

    this.isConnecting = true
    this.logger.info(`[HubClient] Connecting to ${this.config.hubUrl}...`)

    try {
      this.socket = new WebSocket(this.config.hubUrl)

      this.socket.onopen = () => {
        this.handleOpen()
      }

      this.socket.onmessage = (event) => {
        this.handleMessage(event.data)
      }

      this.socket.onclose = () => {
        this.handleClose()
      }

      this.socket.onerror = (error) => {
        this.handleError(error)
      }

      // Wait for connection to be established
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'))
        }, 10000)

        const checkConnection = () => {
          if (this.socket?.readyState === WebSocket.OPEN) {
            clearTimeout(timeout)
            resolve()
          } else if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
            clearTimeout(timeout)
            reject(new Error('Connection failed'))
          } else {
            setTimeout(checkConnection, 100)
          }
        }

        checkConnection()
      })

      this.isConnecting = false
    } catch (err) {
      this.isConnecting = false
      this.logger.error('[HubClient] Connection failed:', err)
      this.scheduleReconnect()
      throw err
    }
  }

  /**
   * Handle WebSocket open
   */
  private handleOpen(): void {
    this.logger.info('[HubClient] Connected to Bridge Hub')
    this.reconnectAttempts = 0

    // Send registration message
    this.send({
      type: 'register',
      data: {
        instanceId: this.config.instanceId,
        workspace: process.cwd(),
        authToken: this.config.authToken,
        capabilities: ['questions', 'permissions', 'directMessaging', 'commands']
      }
    })

    // Start heartbeat to keep connection alive
    this.startHeartbeat()
  }

  /**
   * Handle WebSocket message
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as HubMessage
      this.logger.debug('[HubClient] Received message:', message.type)

      switch (message.type) {
        case 'registered':
          this.logger.info('[HubClient] Registered with hub:', message.data)
          break

        case 'request':
          // Hub is forwarding a request from Telegram user
          this.handleRequest(message.data, message.requestId!)
          break

        case 'response':
          // Response to a previous request we sent
          if (message.requestId && this.pendingRequests.has(message.requestId)) {
            const { resolve } = this.pendingRequests.get(message.requestId)!
            this.pendingRequests.delete(message.requestId)
            resolve(message.data)
          }
          break

        case 'error':
          this.logger.error('[HubClient] Error from hub:', message.data)
          break

        case 'pong':
          // Heartbeat response
          this.lastPongTime = Date.now()
          this.logger.debug('[HubClient] Received pong')
          break
      }
    } catch (err) {
      this.logger.error('[HubClient] Error handling message:', err)
    }
  }

  /**
   * Handle incoming request from Hub
   */
  private async handleRequest(request: HubRequest, requestId: string): Promise<void> {
    this.logger.info('[HubClient] Handling request:', request.type)

    try {
      let response: any

      switch (request.type) {
        case 'prompt':
          // Forward prompt to OpenCode session
          response = await this.handlePrompt(request)
          break

        case 'command':
          // Execute command (e.g., list sessions, get status)
          response = await this.handleCommand(request)
          break

        case 'question_reply':
          // Reply to a question
          response = await this.handleQuestionReply(request)
          break

        case 'permission_reply':
          // Reply to a permission request
          response = await this.handlePermissionReply(request)
          break

        default:
          response = { error: `Unknown request type: ${request.type}` }
      }

      // Send response back to hub
      this.send({
        type: 'response',
        requestId,
        data: response
      })
    } catch (err) {
      this.logger.error('[HubClient] Error handling request:', err)
      this.send({
        type: 'response',
        requestId,
        data: { error: err instanceof Error ? err.message : String(err) }
      })
    }
  }

  /**
   * Handle prompt request
   */
  private async handlePrompt(request: HubRequest): Promise<any> {
    const { text, sessionId } = request

    // Use provided sessionId or get from active sessions
    const targetSessionId = sessionId || await this.getLatestSessionId()

    if (!targetSessionId) {
      return { error: 'No active session found' }
    }

    try {
      const result = await this.input.client.session.prompt({
        path: { id: targetSessionId },
        body: {
          parts: [{ type: 'text', text }]
        }
      })

      if (result.error) {
        return { error: result.error }
      }

      // Extract text from response
      const response = result.data as any
      const responseText = response?.info?.content ||
        response?.parts?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('') ||
        response?.text ||
        'No response text'

      return { text: responseText, sessionId: targetSessionId }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Handle command request
   */
  private async handleCommand(request: HubRequest): Promise<any> {
    const { command, subCommand, args, sessionId } = request

    switch (command) {
      case 'list_sessions':
        return this.listSessions()

      case 'get_status':
        return this.getSessionStatus(args?.sessionId)

      case 'get_todos':
        return this.getSessionTodos(args?.sessionId)

      case 'get_session_title':
        return this.getSessionTitle(sessionId)

      case 'tui_command':
        return this.handleTuiCommand(subCommand, sessionId)

      default:
        return { error: `Unknown command: ${command}` }
    }
  }

  /**
   * Get session title
   */
  private async getSessionTitle(sessionId?: string): Promise<any> {
    if (!sessionId) {
      return { title: '未命名' }
    }

    try {
      const result = await this.input.client.session.get({ path: { id: sessionId } })
      return { title: result.data?.title || '未命名' }
    } catch {
      return { title: '未知会话' }
    }
  }

  /**
   * Handle TUI commands (session_new, session_compact, session_interrupt, autotitle)
   */
  private async handleTuiCommand(command: string, sessionId?: string): Promise<any> {
    try {
      // Get the internal client with proper fetch configured
      const client = (this.input.client as any)._client || this.input.client

      this.logger.info(`[HubClient] Executing TUI command: ${command}`, { sessionId })

      // Special handling for session_new - directly create session
      if (command === 'session_new') {
        const result = await client.post({
          url: '/session',
          body: {
            title: `Remote session ${new Date().toLocaleString('zh-CN')}`,
          },
        })

        if (result.error || !result.data?.id) {
          throw new Error(`Failed to create session: ${JSON.stringify(result.error)}`)
        }

        const newSessionId = result.data.id

        // Navigate TUI to the new session
        try {
          await client.post({
            url: '/tui/select-session',
            body: { sessionID: newSessionId },
          })
          this.logger.info(`[HubClient] TUI navigated to new session: ${newSessionId}`)
        } catch (navError) {
          this.logger.warn(`[HubClient] Failed to navigate TUI to new session`, navError)
        }

        return { success: true, sessionId: newSessionId, message: '新 session 已创建' }
      }

      // Special handling for session_interrupt - use abort API
      if (command === 'session_interrupt') {
        if (!sessionId) {
          throw new Error('未选择 session，无法中断')
        }

        const response = await client.post({
          url: `/session/${sessionId}/abort`,
        })

        if (response.error) {
          throw new Error(`API error: ${JSON.stringify(response.error)}`)
        }

        return { success: true, message: '任务已中断' }
      }

      // Special handling for autotitle
      if (command === 'autotitle') {
        if (!sessionId) {
          throw new Error('未选择 session，无法生成标题')
        }

        this.logger.info(`[autotitle] Starting for session: ${sessionId}`)

        try {
          // Get session messages to generate title
          // Note: OpenCode API uses singular 'message' not 'messages'
          this.logger.info(`[autotitle] Fetching messages from /session/${sessionId}/message`)
          const messagesResult = await client.get({
            url: `/session/${sessionId}/message`,
          })

          this.logger.info(`[autotitle] Messages result:`, messagesResult)

          if (messagesResult.error) {
            this.logger.error(`[autotitle] Failed to get messages:`, messagesResult.error)
            throw new Error(`Failed to get messages: ${JSON.stringify(messagesResult.error)}`)
          }

          const messages = messagesResult.data?.messages || []
          this.logger.info(`[autotitle] Found ${messages.length} messages`)

          if (messages.length > 0) {
            this.logger.info(`[autotitle] First message role: ${messages[0].role}`)
            this.logger.info(`[autotitle] First message content preview:`, messages[0].content?.slice(0, 100))
          }

          // Generate intelligent title based on conversation content
          const title = this.generateSmartTitle(messages)
          this.logger.info(`[autotitle] Generated title: "${title}"`)

          // Update session title via API
          try {
            this.logger.info(`[autotitle] Updating session title via PATCH /session/${sessionId}`)
            const patchResult = await client.patch({
              url: `/session/${sessionId}`,
              body: { title }
            })
            this.logger.info(`[autotitle] Update result:`, patchResult)
          } catch (error) {
            this.logger.error(`[autotitle] Failed to update session title:`, error)
          }

          this.logger.info(`[autotitle] Returning success with title: "${title}"`)
          return {
            success: true,
            title: title,
            message: '标题已生成'
          }
        } catch (err) {
          this.logger.error(`[autotitle] Error during execution:`, err)
          throw err
        }
      }

      // For other commands (session_compact), use execute-command API
      const validCommands = ['session_compact']
      if (!validCommands.includes(command)) {
        throw new Error(`未知命令: ${command}`)
      }

      const response = await client.post({
        url: '/tui/execute-command',
        body: { command },
      })

      if (response.error) {
        throw new Error(`API error: ${JSON.stringify(response.error)}`)
      }

      return { success: true, message: `命令 ${command} 执行成功` }
    } catch (error) {
      this.logger.error(`[HubClient] Error executing TUI command: ${command}`, error)
      return { 
        error: error instanceof Error ? error.message : String(error) 
      }
    }
  }

  /**
   * Handle question reply
   */
  private async handleQuestionReply(request: HubRequest): Promise<any> {
    const { requestId, value } = request

    try {
      const client = (this.input.client as any)._client || this.input.client

      if (value === '__reject__') {
        await client.post({
          url: `/question/${requestId}/reject`
        })
      } else {
        await client.post({
          url: `/question/${requestId}/reply`,
          body: { answers: [[value]] }
        })
      }

      return { success: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Handle permission reply
   */
  private async handlePermissionReply(request: HubRequest): Promise<any> {
    const { requestId, value } = request

    try {
      const client = (this.input.client as any)._client || this.input.client

      // Map value to OpenCode Permission.Reply format
      // 'once' -> { type: 'once' }
      // 'always' -> { type: 'always' }
      // 'reject' -> { type: 'reject' }
      const replyValue = value === 'once' ? { type: 'once' } :
                        value === 'always' ? { type: 'always' } :
                        { type: 'reject' }

      this.logger.info(`[handlePermissionReply] Sending permission reply:`, { requestId, reply: replyValue })

      const result = await client.post({
        url: `/permission/${requestId}/reply`,
        body: { reply: replyValue }
      })

      this.logger.info(`[handlePermissionReply] Permission reply result:`, result)

      return { success: true }
    } catch (err) {
      this.logger.error(`[handlePermissionReply] Error:`, err)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * List all sessions
   */
  private async listSessions(): Promise<any> {
    try {
      const result = await this.input.client.session.list()

      if ('error' in result && result.error) {
        return { error: result.error }
      }

      const sessions = (result as any).data || []

      // Get status for each session
      const sessionsWithStatus = await Promise.all(
        sessions.map(async (session: any) => {
          try {
            const statusRes = await this.input.client.session.status({ path: { id: session.id } })
            const todoRes = await this.input.client.session.todo({ path: { id: session.id } })

            const statusData = (statusRes.data as any)?.[session.id]
            const status = statusData?.type || 'unknown'
            const todos = todoRes.data?.todos || []

            return {
              ...session,
              status,
              todoCount: todos.length,
              completedCount: todos.filter((t: any) => t.completed).length
            }
          } catch {
            return { ...session, status: 'unknown', todoCount: 0, completedCount: 0 }
          }
        })
      )

      return { sessions: sessionsWithStatus }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Get session status
   */
  private async getSessionStatus(sessionId?: string): Promise<any> {
    const targetSessionId = sessionId || await this.getLatestSessionId()

    if (!targetSessionId) {
      return { error: 'No session found' }
    }

    try {
      const result = await this.input.client.session.status({ path: { id: targetSessionId } })
      return { sessionId: targetSessionId, status: result.data }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Get session todos
   */
  private async getSessionTodos(sessionId?: string): Promise<any> {
    const targetSessionId = sessionId || await this.getLatestSessionId()

    if (!targetSessionId) {
      return { error: 'No session found' }
    }

    try {
      const result = await this.input.client.session.todo({ path: { id: targetSessionId } })
      return { sessionId: targetSessionId, todos: result.data }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Get latest session ID
   */
  private async getLatestSessionId(): Promise<string | null> {
    try {
      const result = await this.input.client.session.list()
      const sessions = result.data || []

      if (sessions.length === 0) {
        return null
      }

      // Sort by updated time, return most recent
      const sorted = sessions.sort((a: any, b: any) => {
        const aTime = new Date(a.time?.updated || 0).getTime()
        const bTime = new Date(b.time?.updated || 0).getTime()
        return bTime - aTime
      })

      return sorted[0].id
    } catch {
      return null
    }
  }

  /**
   * Send event to hub (e.g., question.asked, permission.asked)
   */
  async sendEvent(eventType: string, data: any): Promise<void> {
    this.send({
      type: 'event',
      data: {
        eventType,
        ...data
      }
    })
  }

  /**
   * Send message to hub
   */
  private send(message: HubMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
    } else {
      this.logger.warn('[HubClient] Cannot send message, socket not open')
    }
  }

  /**
   * Handle WebSocket close
   */
  private handleClose(): void {
    this.logger.info('[HubClient] Connection closed')
    this.stopHeartbeat()
    this.scheduleReconnect()
  }

  /**
   * Handle WebSocket error
   */
  private handleError(error: Event): void {
    this.logger.error('[HubClient] WebSocket error:', error)
  }

  /**
   * Schedule reconnection
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('[HubClient] Max reconnection attempts reached')
      return
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }

    this.reconnectAttempts++
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5)

    this.logger.info(`[HubClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        // Error already logged in connect()
      })
    }, delay)
  }

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastPongTime: number = Date.now()
  private pongCheckTimer: ReturnType<typeof setInterval> | null = null

  /**
   * Send heartbeat
   */
  private startHeartbeat(): void {
    // Clear existing timers if any
    this.stopHeartbeat()

    this.lastPongTime = Date.now()

    // Send ping every 20 seconds
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' })
        this.logger.debug('[HubClient] Sent heartbeat ping')
      }
    }, 20000)

    // Check if we received pong within 60 seconds
    this.pongCheckTimer = setInterval(() => {
      const timeSinceLastPong = Date.now() - this.lastPongTime
      if (timeSinceLastPong > 60000) {
        this.logger.warn(`[HubClient] No pong received for ${timeSinceLastPong}ms, reconnecting...`)
        this.socket?.close()
        this.handleClose()
      }
    }, 10000)
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.pongCheckTimer) {
      clearInterval(this.pongCheckTimer)
      this.pongCheckTimer = null
    }
  }

  /**
   * Disconnect from hub
   */
  disconnect(): void {
    this.stopHeartbeat()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.socket) {
      this.socket.close()
      this.socket = null
    }

    this.logger.info('[HubClient] Disconnected')
  }
}
