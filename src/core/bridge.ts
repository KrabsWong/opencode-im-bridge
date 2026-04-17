import type {
  IMAdapter,
  IMMessage,
  IMCallbackQuery,
  IMOutgoingMessage,
  QuestionInfo,
  PermissionInfo,
  SessionInfo,
  BridgeConfig
} from "../types/index.js"
import type { PluginInput } from "@opencode-ai/plugin"
import { IMBridgeLogger } from "./logger.js"
import { markdownToTelegramHtml } from "./markdown.js"

interface PendingRequest {
  type: "question" | "permission"
  id: string
  sessionId: string
  messageId?: string
  timestamp: number
}

interface SessionMapping {
  imUserId: string
  sessionId: string
  lastActivity: number
}

/**
 * Image library - predefined images that can be sent to Telegram
 */
const IMAGE_LIBRARY: Record<string, { path: string; description: string }> = {
  architecture: {
    path: "/Users/krabswang/Personal/opencode-hooks/opencode-im-bridge/architecture.png",
    description: "系统架构图",
  },
  // Add more images here as needed:
  // workflow: { path: "/path/to/workflow.png", description: "工作流程图" },
}

/**
 * Core bridge that handles bidirectional communication between OpenCode and IM platforms
 */
export class IMBridge {
  private adapter: IMAdapter
  private input: PluginInput
  private config: BridgeConfig
  private pendingRequests = new Map<string, PendingRequest>()
  private sessionMappings = new Map<string, SessionMapping>() // imUserId -> session
  private messageHistory = new Map<string, string>() // requestId -> messageId
  private logger: IMBridgeLogger

  constructor(adapter: IMAdapter, input: PluginInput, config: BridgeConfig = {}) {
    this.adapter = adapter
    this.input = input
    this.logger = new IMBridgeLogger()
    this.config = {
      adminUsers: [],
      allowedChats: [],
      features: {
        questions: true,
        permissions: true,
        directMessaging: true,
      },
      ...config,
    }
  }
  
  /**
   * Initialize the bridge
   */
  async initialize(): Promise<void> {
    // Set up message handler
    this.adapter.onMessage((message) => this.handleIncomingMessage(message))
    
    // Set up callback handler
    this.adapter.onCallback((callback) => this.handleCallback(callback))
    
    // Start the adapter
    await this.adapter.start()
    
  }
  
  /**
   * Stop the bridge
   */
  async stop(): Promise<void> {
    this.logger.stop()
    await this.adapter.stop()
  }

  /**
   * Flush logs to file
   */
  async flushLogs(): Promise<string> {
    await this.logger.flush()
    return "日志已刷新到文件"
  }

  /**
   * Get recent log entries
   */
  getRecentLogs(count: number = 50): string {
    return this.logger.getRecentEntries(count)
  }
  
  /**
   * Handle incoming messages from IM platform
   */
  private async handleIncomingMessage(message: IMMessage): Promise<void> {
    // Check authorization
    if (!this.isAuthorized(message.user.id)) {
      return
    }
    
    const text = message.text.trim()
    const userId = message.user.id
    
    // Parse commands
    if (text.startsWith("/")) {
      await this.handleCommand(text, userId, message)
      return
    }

    // Handle direct messaging if enabled
    if (this.config.features?.directMessaging) {
      await this.handleDirectMessage(text, userId, message)
    }
  }
  
  /**
   * Handle callback queries (button clicks)
   */
  private async handleCallback(callback: IMCallbackQuery): Promise<void> {
    if (!this.isAuthorized(callback.user.id)) {
      return
    }

    // Parse callback data: "action:id:value"
    const parts = callback.data.split(":")
    const action = parts[0]
    const requestId = parts[1]
    const value = parts.slice(2).join(":")

    this.logger.debug("Callback received", { action, requestId, value })
    this.logger.debug("Pending requests", { keys: Array.from(this.pendingRequests.keys()) })

    try {
      switch (action) {
        case "reply":
          await this.handleQuestionReply(requestId, value)
          break
        case "permission":
          await this.handlePermissionReply(requestId, value as "once" | "always" | "reject")
          break
        case "select_session":
          await this.handleSessionSelect(callback.user.id, requestId)
          break
        default:
          this.logger.warn(`Unknown callback action: ${action}`)
      }
    } catch (error) {
      this.logger.error("Error handling callback", error)
    }
  }
  
  /**
   * Handle bot commands
   */
  private async handleCommand(text: string, userId: string, message: IMMessage): Promise<void> {
    try {
      const command = text.split(" ")[0].toLowerCase()
      const args = text.slice(command.length).trim()
      
      switch (command) {
        case "/help":
          await this.sendHelp()
          break
        case "/sessions":
          await this.listSessions(userId)
          break
        case "/use":
          if (args) {
            await this.selectSession(userId, args)
          }
          break
        case "/ask":
          if (args && this.config.features?.directMessaging) {
            // Check if user has selected a session
            const mapping = this.sessionMappings.get(userId)
            if (!mapping) {
              await this.sendMessage({
                text: "<b>请先选择会话</b>\n\n使用 /sessions 查看并选择会话，\n或者使用 /use <sessionId> 直接选择。",
                parseMode: "html",
              })
              return
            }
            await this.handleDirectMessage(args, userId, message)
          } else {
            await this.sendMessage({
              text: "<b>请提供消息内容</b>\n\n例如: <code>/ask 现在进度如何？</code>",
              parseMode: "html",
            })
          }
          break
        case "/current":
          await this.showCurrentSession(userId)
          break
        default:
          await this.sendMessage({
            text: `<b>未知命令</b>: ${command}\n使用 /help 查看可用命令`,
            parseMode: "html"
          })
      }
    } catch (error) {
      this.logger.error("Error handling command", error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      await this.sendMessage({
        text: `<b>命令执行失败</b>\n━━━━━━━━━━━━━━━━━━━━\n错误: <code>${this.escapeHtml(errorMessage)}</code>`,
        parseMode: "html"
      })
    }
  }

  /**
   * Handle remote control command
   */
  private async handleRemoteCommand(args: string): Promise<void> {
    const action = args.trim() || "status"
    
    switch (action) {
      case "status":
        await this.sendMessage({
          text: `📡 <b>连接状态</b>\n\n状态: ✅ 已连接\n平台: Telegram`,
          parseMode: "html",
        })
        break
      case "restart":
        await this.sendMessage({
          text: `🔄 <b>重启连接</b>\n\n正在重启 IM Bridge...`,
          parseMode: "html",
        })
        // Note: Actual restart needs to be handled at plugin level
        break
      default:
        await this.sendMessage({
          text: `<b>未知操作</b>: ${action}\n可用操作: status, restart`,
          parseMode: "html"
        })
    }
  }

  /**
   * Handle image send command
   */
  /**
   * Send help message
   */
  private async sendHelp(): Promise<void> {
    const template = this.config.templates?.help
    const text = template
      ? template()
      : `<b>欢迎使用 OpenCode IM Bridge</b>
━━━━━━━━━━━━━━━━━━━━
<b>可用命令：</b>
/sessions - 列出所有会话
/current - 查看当前选中的会话
/use &lt;sessionId&gt; - 选择特定会话
/ask &lt;message&gt; - 向当前会话发送消息

<b>说明：</b>
- /sessions 显示所有会话（按 busy → retry → idle 排序）
- 使用 /use 选择会话后，/ask 会直接向该会话发送消息
- 当 AI 需要确认时，会自动推送消息给你`

    await this.sendMessage({ text, parseMode: "html" })
  }

  /**
   * List all sessions - show active and recent sessions
   */
  private async listSessions(userId: string): Promise<void> {
    try {
      const sessions = await this.input.client.session.list()

      if (!sessions.data || sessions.data.length === 0) {
        await this.sendMessage({ text: "<b>没有会话</b>\n\n当前没有活动的会话。" })
        return
      }

      const sessionStatuses = await Promise.all(
        sessions.data.map(async (session: any) => {
          try {
            const statusRes = await this.input.client.session.status({ path: { id: session.id } })
            const todoRes = await this.input.client.session.todo({ path: { id: session.id } })

            // Debug: log full response to understand structure
            this.logger.info(`Status API response for ${session.id}`, {
              fullData: JSON.stringify(statusRes.data),
              dataType: typeof statusRes.data,
              isArray: Array.isArray(statusRes.data),
              keys: statusRes.data ? Object.keys(statusRes.data as any) : null
            })

            // Try multiple possible formats
            let statusType = "unknown"
            const data = statusRes.data as any

            if (data) {
              // Format 1: { sessionId: { type: "idle" } }
              if (data[session.id]?.type) {
                statusType = data[session.id].type
              }
              // Format 2: { type: "idle" }
              else if (data.type) {
                statusType = data.type
              }
              // Format 3: Direct value
              else if (typeof data === 'string') {
                statusType = data
              }
            }

            const todos = todoRes.data?.todos || []

            // Calculate last activity time
            const lastUpdate = session.time?.updated 
              ? new Date(session.time.updated).getTime() 
              : 0
            const inactiveTime = Date.now() - lastUpdate
            const isRecent = inactiveTime < 60 * 60 * 1000 // 1 hour

            // Show sessions that are: busy, retry, or recently active (< 1h)
            const isActive = statusType === "busy" || statusType === "retry" || isRecent

            return {
              session,
              status: statusType,
              isActive,
              isRecent,
              inactiveTime,
              todoCount: todos.length,
              completedCount: todos.filter((t: any) => t.completed).length,
            }
          } catch (err) {
            this.logger.error(`Error fetching status for ${session.id}`, err)
            return {
              session,
              status: "error",
              isActive: false,
              isRecent: false,
              inactiveTime: Infinity,
              todoCount: 0,
              completedCount: 0,
            }
          }
        })
      )

      // Filter out error sessions but keep all others (busy/retry/idle/recent)
      const activeSessionsData = sessionStatuses.filter(s => s.status !== "error")
      
      // Sort by status priority: busy > retry > idle > unknown
      activeSessionsData.sort((a, b) => {
        const priority = { busy: 0, retry: 1, idle: 2, unknown: 3 }
        return (priority[a.status as keyof typeof priority] ?? 4) - (priority[b.status as keyof typeof priority] ?? 4)
      })

      if (activeSessionsData.length === 0) {
        await this.sendMessage({
          text: `<b>没有会话</b>

当前没有可用的会话。`,
          parseMode: "html"
        })
        return
      }

      // Use pre-fetched data
      const sessionDetails = activeSessionsData.map(s => ({
        ...s.session,
        status: s.status,
        todoCount: s.todoCount,
        completedCount: s.completedCount,
      }))

      // Format the list message
      const activeCount = activeSessionsData.length
      const totalCount = sessions.data.length

      let text = `<b>会话列表</b> (${activeCount}/${totalCount})\n`
      text += `<i>按状态排序: busy → retry → idle</i>\n`
      text += `━━━━━━━━━━━━━━━━━━━━\n\n`
      
      sessionDetails.forEach((session: any, index: number) => {
        const title = session.title || "未命名会话"
        const status = session.status || "idle"
        const statusLabel = this.getStatusLabel(status)
        
        // Format time
        let timeStr = ""
        try {
          timeStr = session.time?.updated 
            ? this.formatRelativeTime(new Date(session.time.updated))
            : ""
        } catch {
          timeStr = ""
        }
        
        text += `<b>[${index + 1}] ${this.escapeHtml(title)}</b>\n`
        text += `ID: <code>${session.id}</code>\n`
        text += `状态: ${statusLabel} | 任务: ${session.completedCount}/${session.todoCount}${timeStr ? ` | ${timeStr}` : ""}\n\n`
      })
      
      text += `━━━━━━━━━━━━━━━━━━━━\n`
      text += "<i>点击按钮选择会话</i>"
      
      // Create keyboard with better labels
      const keyboard = sessionDetails.map((session: any) => {
        const title = session.title?.slice(0, 25) || "未命名"
        const statusLabel = this.getStatusLabel(session.status)
        return [{
          text: `[${statusLabel}] ${title}`,
          callbackData: `select_session:${session.id}:`,
        }]
      })
      
      await this.sendMessage({
        text,
        keyboard: { inline: keyboard },
        parseMode: "html",
      })
    } catch (error) {
      this.logger.error("Error listing sessions", error)
      await this.sendMessage({
        text: "获取会话列表失败: " + (error instanceof Error ? error.message : String(error))
      })
    }
  }
  
  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    if (!text) return ""
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  }
  
  /**
   * Get label for session status (OpenCode: idle, busy, retry)
   */
  private getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      busy: "运行中",
      retry: "重试中",
      idle: "空闲",
      error: "错误",
      unknown: "未知",
    }
    return labels[status] || status
  }

  /**
   * Get emoji for session status (OpenCode: idle, busy, retry) - kept for backward compatibility
   */
  private getStatusEmoji(status: string): string {
    const emojis: Record<string, string> = {
      busy: "⚡",      // Currently executing
      retry: "🔄",     // Retrying
      idle: "💤",      // Idle (window open but not processing)
      unknown: "❓",
    }
    return emojis[status] || "📄"
  }
  
  /**
   * Format relative time (e.g., "2分钟前")
   */
  private formatRelativeTime(date: Date): string {
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffSec = Math.floor(diffMs / 1000)
    const diffMin = Math.floor(diffSec / 60)
    const diffHour = Math.floor(diffMin / 60)
    const diffDay = Math.floor(diffHour / 24)
    
    if (diffSec < 60) return "刚刚"
    if (diffMin < 60) return `${diffMin}分钟前`
    if (diffHour < 24) return `${diffHour}小时前`
    if (diffDay < 7) return `${diffDay}天前`
    return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" })
  }
  
  /**
   * Select a session for a user
   */
  private async selectSession(userId: string, sessionId: string): Promise<void> {
    this.sessionMappings.set(userId, {
      imUserId: userId,
      sessionId,
      lastActivity: Date.now(),
    })
    
    // Try to get session info for better display
    let sessionTitle = ""
    try {
      const sessionInfo = await this.input.client.session.get({ path: { id: sessionId } })
      sessionTitle = String(sessionInfo.data?.title || "")
    } catch {
      // Ignore error, use ID only
    }
    
    const titleDisplay = sessionTitle ? `<b>${this.escapeHtml(sessionTitle)}</b>` : "未命名会话"

    await this.sendMessage({
      text: `<b>已选择会话</b>\n名称: ${titleDisplay}\nID: <code>${sessionId}</code>\n\n你发送的消息将发送到这个会话。`,
      parseMode: "html",
    })
  }
  
  /**
   * Handle session selection from callback
   */
  private async handleSessionSelect(userId: string, sessionId: string): Promise<void> {
    await this.selectSession(userId, sessionId)
  }

  /**
   * Show current selected session
   */
  private async showCurrentSession(userId: string): Promise<void> {
    const mapping = this.sessionMappings.get(userId)

    if (!mapping) {
      await this.sendMessage({
        text: "📭 当前没有选择会话\n\n使用 /sessions 查看并选择会话",
        parseMode: "html",
      })
      return
    }

    try {
      const sessionInfo = await this.input.client.session.get({ path: { id: mapping.sessionId } })
      const title = sessionInfo.data?.title || "未命名会话"
      const statusRes = await this.input.client.session.status({ path: { id: mapping.sessionId } })
      // status() returns dictionary { [sessionId]: { type: "idle"|"busy"|"retry" } }
      const statusData = (statusRes.data as any)?.[mapping.sessionId]
      const statusType = statusData?.type || "unknown"
      const statusLabel = this.getStatusLabel(statusType)

      await this.sendMessage({
        text: `<b>当前会话</b>\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `名称: <b>${this.escapeHtml(title)}</b>\n` +
              `ID: <code>${mapping.sessionId}</code>\n` +
              `状态: ${statusLabel}\n\n` +
              `使用 /ask &lt;message&gt; 发送消息`,
        parseMode: "html",
      })
    } catch {
      await this.sendMessage({
        text: `<b>当前会话</b>\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `ID: <code>${mapping.sessionId}</code>\n` +
              `(无法获取详细信息)`,
        parseMode: "html",
      })
    }
  }
  
  /**
   * Check if AI response contains image trigger markers and send images automatically
   * Format: [SEND_IMAGE_TO_IM] - sends the default architecture image
   */
  private async checkAndSendImagesFromResponse(responseText: string): Promise<string> {
    // Pattern to match [SEND_IMAGE_TO_IM]
    const imagePattern = /\[SEND_IMAGE_TO_IM\]/g
    let processedText = responseText

    // Default image to send (architecture)
    const defaultImageName = "architecture"
    const imageInfo = IMAGE_LIBRARY[defaultImageName]

    if (!imageInfo) {
      this.logger.error(`Default image not found in library: ${defaultImageName}`)
      return processedText
    }

    let match
    while ((match = imagePattern.exec(responseText)) !== null) {
      const fullMatch = match[0]

      this.logger.info(`Detected image trigger: ${defaultImageName}`)

      // Check if adapter supports sending photos
      if (!this.adapter.sendPhoto) {
        this.logger.error("Adapter does not support sendPhoto")
        continue
      }

      // Check if image file exists
      const file = Bun.file(imageInfo.path)
      const exists = await file.exists()
      if (!exists) {
        this.logger.error(`Image file not found: ${imageInfo.path}`)
        await this.sendMessage({
          text: `图片文件不存在: ${imageInfo.path}\n\n请检查图片文件是否已放置到正确位置。`,
        })
        processedText = processedText.replace(fullMatch, `[图片文件不存在]`)
        continue
      }

      try {
        // Send the image
        await this.adapter.sendPhoto(
          imageInfo.path,
          `<b>${imageInfo.description}</b>`
        )
        this.logger.info(`Auto-sent image: ${defaultImageName}`)

        // Remove the marker from the response text
        processedText = processedText.replace(fullMatch, "")
      } catch (error) {
        this.logger.error(`Failed to auto-send image ${defaultImageName}:`, error)
        await this.sendMessage({
          text: `发送图片失败: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }

    return processedText.trim()
  }

  /**
   * Handle direct messages to sessions
   */
  private async handleDirectMessage(text: string, userId: string, _message: IMMessage): Promise<void> {
    // Check if this is an image trigger message from AI
    // AI can use format: [SEND_IMAGE:architecture] or [SEND_IMAGE:architecture|Custom caption]
    if (text.includes("[SEND_IMAGE:")) {
      this.logger.info("Detected image trigger in message")
      await this.checkAndSendImagesFromResponse(text)
      return
    }

    let sessionId = this.sessionMappings.get(userId)?.sessionId
    
    // Auto-select the latest session if none is selected
    if (!sessionId) {
      const sessions = await this.input.client.session.list()
      if (sessions.data?.[0]) {
        sessionId = sessions.data[0].id
        this.sessionMappings.set(userId, {
          imUserId: userId,
          sessionId,
          lastActivity: Date.now(),
        })
      }
    }
    
    if (!sessionId) {
      await this.sendMessage({
        text: "没有选中的会话。请先使用 /sessions 选择会话，或我会自动使用最新的会话。",
      })
      return
    }
    
    // Declare responseText outside try block for fallback access
    let responseText = ""
    
    try {
      this.logger.debug(`Sending message to session ${sessionId}`, { text: text.slice(0, 100) })

      // First, check if session exists and get session info + status
      let sessionTitle = ""
      let sessionStatus = "unknown"
      try {
        const sessionCheck = await this.input.client.session.get({ path: { id: sessionId } })
        const statusRes = await this.input.client.session.status({ path: { id: sessionId } })
        this.logger.debug("Session check", { found: !!sessionCheck.data })
        sessionTitle = String(sessionCheck.data?.title || "")
        // status() returns dictionary { [sessionId]: { type: "idle"|"busy"|"retry" } }
        const statusData = (statusRes.data as any)?.[sessionId]
        sessionStatus = statusData?.type || "unknown"
      } catch (checkErr) {
        this.logger.error("Session check failed", checkErr)
        throw new Error(`会话不存在或已过期: ${sessionId}`)
      }

      // Warn if session is not active
      if (sessionStatus === "idle") {
        await this.sendMessage({
          text: `<b>警告: 会话可能已关闭或不活跃</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `名称: ${this.escapeHtml(sessionTitle || "未命名")}\n` +
                `ID: <code>${sessionId}</code>\n` +
                `状态: ${this.getStatusLabel(sessionStatus)}\n\n` +
                `消息仍会尝试发送，但可能无法得到响应。\n` +
                `建议使用 /sessions 选择活跃的会话。`,
          parseMode: "html",
        })
        // Continue anyway but warn user
      }

      // Send initial "processing" message with full session info
      const titleDisplay = sessionTitle ? `<b>${this.escapeHtml(sessionTitle)}</b>\n` : ""
      await this.sendMessage({
        text: `<b>正在处理请求...</b>\n${titleDisplay}ID: <code>${sessionId}</code>`,
        parseMode: "html",
      })

      const result = await this.input.client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: text }] },
      })

      this.logger.debug("Prompt result", { result: JSON.stringify(result, null, 2).slice(0, 500) })
      
      if (result.error) {
        throw new Error(`OpenCode error: ${JSON.stringify(result.error)}`)
      }
      
      // Extract AI response from result
      const response = result.data as any
      responseText = ""
      
      if (response) {
        // Try different response formats
        responseText = response.info?.content || 
          response.parts?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ||
          response.text ||
          JSON.stringify(response).slice(0, 500)
      }
      
      if (!responseText) {
        responseText = "AI 已处理请求，但没有返回文本内容。"
      }
      
      // Store original response for potential fallback
      const originalResponseText = responseText
      
      // Check for image triggers in AI response and auto-send images
      let processedResponse = await this.checkAndSendImagesFromResponse(responseText)

      // Truncate if too long
      const maxLength = 3500 // Telegram limit is 4096, leave some margin
      const displayResponse = processedResponse.length > maxLength
        ? processedResponse.slice(0, maxLength) + "...\n\n[消息过长，已截断]"
        : processedResponse

      // Convert Markdown to HTML for AI response
      this.logger.debug("Original AI response before markdown conversion", { 
        text: displayResponse.substring(0, 500),
        length: displayResponse.length 
      })
      const htmlResponse = markdownToTelegramHtml(displayResponse)
      this.logger.debug("Converted HTML response", { 
        text: htmlResponse.substring(0, 500),
        length: htmlResponse.length 
      })

      // Send the AI response (only if there's content left after removing image markers)
      if (htmlResponse.trim()) {
        await this.sendMessage({
          text: `<b>AI 回复</b>\n\n${htmlResponse}`,
          parseMode: "html",
        })
      }
    } catch (error) {
      this.logger.error("Error sending message", error)
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Fallback: try to send the original response text as plain text
      try {
        if (responseText) {
          await this.adapter.sendMessage({
            text: `[AI 回复 - 格式渲染失败，显示原始内容]\n\n${responseText}`,
            parseMode: "plain",
          })
        } else {
          throw new Error("No response text available")
        }
      } catch (fallbackError) {
        // If even plain text fails, send error message
        await this.sendMessage({
          text: `<b>发送消息失败</b>\n━━━━━━━━━━━━━━━━━━━━\n错误: <code>${this.escapeHtml(errorMessage)}</code>\n\n请检查:\n1. 会话 ID 是否正确\n2. 会话是否仍然活跃\n3. 使用 /sessions 查看可用会话`,
          parseMode: "html",
        })
      }
    }
  }
  
  // ===== OpenCode Event Handlers =====
  
  /**
   * Handle question.asked event from OpenCode
   */
  async onQuestionAsked(info: QuestionInfo): Promise<void> {
    if (!this.config.features?.questions) return

    this.logger.info(`Question asked: ${info.id}`, { sessionId: info.sessionId })

    const template = this.config.templates?.question
    const text = template
      ? template(info)
      : this.formatQuestionText(info)

    // Build keyboard from options
    const keyboard = info.questions[0]?.options.map((opt) => [{
      text: opt.label,
      callbackData: `reply:${info.id}:${opt.label}`,
    }])

    // Add reject button
    keyboard?.push([{
      text: "[拒绝回答]",
      callbackData: `reply:${info.id}:__reject__`,
    }])

    this.logger.debug("Question callbackData", { pattern: `reply:${info.id}:<value>` })

    try {
      const result = await this.sendMessage({
        text,
        keyboard: keyboard ? { inline: keyboard } : undefined,
        parseMode: "html",
      })

      this.logger.info("Question sent", { id: info.id, messageId: result.messageId })

      this.pendingRequests.set(info.id, {
        type: "question",
        id: info.id,
        sessionId: info.sessionId,
        messageId: result.messageId,
        timestamp: Date.now(),
      })

      this.messageHistory.set(info.id, result.messageId)

      this.logger.debug("Pending request stored", { pendingCount: this.pendingRequests.size })
    } catch (error) {
      this.logger.error("Error sending question", error)
    }
  }
  
  /**
   * Format question text with HTML
   */
  private formatQuestionText(info: QuestionInfo): string {
    const q = info.questions[0]
    let text = `<b>需要您的确认</b>\n━━━━━━━━━━━━━━━━━━━━\n`
    text += `<b>${this.escapeHtml(q.header)}</b>\n\n`
    text += `${this.escapeHtml(q.question)}\n\n`

    if (q.options.length > 0) {
      text += `<b>选项:</b>\n`
      q.options.forEach((opt, idx) => {
        text += `${idx + 1}. ${this.escapeHtml(opt.label)}: ${this.escapeHtml(opt.description)}\n`
      })
    }

    return text
  }
  
  /**
   * Handle permission.asked event from OpenCode
   */
  async onPermissionAsked(info: PermissionInfo): Promise<void> {
    if (!this.config.features?.permissions) return
    
    const template = this.config.templates?.permission
    const text = template
      ? template(info)
      : this.formatPermissionText(info)
    
    const keyboard = [[
      { text: "[允许一次]", callbackData: `permission:${info.id}:once` },
      { text: "[总是允许]", callbackData: `permission:${info.id}:always` },
    ], [
      { text: "[拒绝]", callbackData: `permission:${info.id}:reject` },
    ]]
    
    try {
      const result = await this.sendMessage({
        text,
        keyboard: { inline: keyboard },
        parseMode: "html",
      })
      
      this.pendingRequests.set(info.id, {
        type: "permission",
        id: info.id,
        sessionId: info.sessionId,
        messageId: result.messageId,
        timestamp: Date.now(),
      })

      this.messageHistory.set(info.id, result.messageId)
    } catch (error) {
      this.logger.error("Error sending permission request", error)
    }
  }
  
  /**
   * Format permission text with HTML
   */
  private formatPermissionText(info: PermissionInfo): string {
    let text = `<b>权限请求</b>\n━━━━━━━━━━━━━━━━━━━━\n`
    text += `工具: <code>${info.permission}</code>\n`
    text += `路径:\n`
    info.patterns.forEach((pattern, idx) => {
      text += `${idx + 1}. <code>${pattern}</code>\n`
    })
    return text
  }
  
  /**
   * Handle question replied event
   */
  async onQuestionReplied(requestId: string): Promise<void> {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return
    
    // Update the message if possible
    const messageId = this.messageHistory.get(requestId)
    if (messageId && this.adapter.editMessage) {
      try {
        await this.adapter.editMessage(messageId, {
          text: `<b>已回复</b>\n━━━━━━━━━━━━━━━━━━━━\n请求 ID: <code>${requestId}</code>`,
          parseMode: "html",
        })
      } catch {
        // Ignore edit errors
      }
    }
    
    this.pendingRequests.delete(requestId)
  }
  
  /**
   * Handle permission replied event
   */
  async onPermissionReplied(requestId: string): Promise<void> {
    this.pendingRequests.delete(requestId)
  }

  /**
   * Handle session created event
   */
  async onSessionCreated(sessionId: string, sessionInfo: any): Promise<void> {
    this.logger.info(`Session created: ${sessionId}`, { sessionInfo })

    try {
      const title = sessionInfo?.title || "未命名会话"
      const directory = this.input.directory || "未知目录"
      const time = new Date().toLocaleString("zh-CN")

      const text = `<b>新会话已启动</b>
━━━━━━━━━━━━━━━━━━━━
名称: ${this.escapeHtml(title)}
ID: <code>${sessionId}</code>
目录: <code>${this.escapeHtml(directory)}</code>
时间: ${time}
━━━━━━━━━━━━━━━━━━━━
使用 /sessions 查看所有会话
使用 /use <完整ID> 选择此会话`

      await this.sendMessage({
        text,
        parseMode: "html",
      })

      this.logger.info(`Session created notification sent for ${sessionId}`)
    } catch (error) {
      this.logger.error("Error sending session created notification", error)
    }
  }

  // ===== Response Handlers =====
  
  /**
   * Handle question reply from IM
   */
  private async handleQuestionReply(requestId: string, value: string): Promise<void> {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) {
      return
    }

    try {
      this.logger.info(`Replying to question ${requestId}`, { value })

      // SDK v1 doesn't expose question API, use client's internal fetch
      // Use the SDK client's internal _client which has proper fetch configured (app.fetch)
      const client = (this.input.client as any)._client || this.input.client

      if (value === "__reject__") {
        // Reject the question
        this.logger.debug(`Calling question.reject for ${requestId}`)
        const response = await client.post({
          url: `/question/${requestId}/reject`,
        })

        if (response.error) {
          throw new Error(`API error: ${JSON.stringify(response.error)}`)
        }
      } else {
        // Reply to the question
        this.logger.debug(`Calling question.reply for ${requestId}`, { answers: [[value]] })
        const response = await client.post({
          url: `/question/${requestId}/reply`,
          body: { answers: [[value]] },
        })

        if (response.error) {
          throw new Error(`API error: ${JSON.stringify(response.error)}`)
        }
      }

      this.logger.info(`API call successful for ${requestId}`)

      // Update message
      const messageId = this.messageHistory.get(requestId)
      if (messageId && this.adapter.editMessage) {
        this.logger.debug(`Editing message ${messageId}`)
        await this.adapter.editMessage(messageId, {
          text: value === "__reject__"
            ? `<b>已拒绝</b>\n━━━━━━━━━━━━━━━━━━━━\n请求 ID: <code>${requestId}</code>`
            : `<b>已选择:</b> ${this.escapeHtml(value)}\n━━━━━━━━━━━━━━━━━━━━\n请求 ID: <code>${requestId}</code>`,
          parseMode: "html",
        })
        this.logger.debug(`Message ${messageId} edited successfully`)
      } else {
        this.logger.debug(`Cannot edit message`, { messageId, hasEditMethod: !!this.adapter.editMessage })
      }

      this.pendingRequests.delete(requestId)
      this.logger.debug(`Pending request deleted for ${requestId}`)
    } catch (error) {
      this.logger.error("Error replying to question", error)
      const errorMsg = error instanceof Error ? error.message : String(error)
      await this.sendMessage({
        text: `发送回复失败: ${errorMsg}\n\n请检查 OpenCode 日志获取详细信息`,
        parseMode: "html",
      })
    }
  }
  
  /**
   * Handle permission reply from IM
   */
  private async handlePermissionReply(
    requestId: string,
    value: "once" | "always" | "reject"
  ): Promise<void> {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) {
      return
    }

    try {
      // Map to permission API values
      const reply = value === "reject" ? "reject" : value

      // SDK v1 doesn't expose permission API, use client's internal fetch
      const client = (this.input.client as any)._client || this.input.client

      this.logger.debug(`Calling permission reply for ${requestId}`, { reply })

      // Correct API endpoint: POST /permission/{requestID}/reply
      const response = await client.post({
        url: `/permission/${requestId}/reply`,
        body: { reply },
      })

      if (response.error) {
        throw new Error(`API error: ${JSON.stringify(response.error)}`)
      }

      this.logger.info(`Permission reply successful for ${requestId}`)

      // Update message
      const messageId = this.messageHistory.get(requestId)
      if (messageId && this.adapter.editMessage) {
        const statusText = value === "once"
          ? "[允许一次]"
          : value === "always"
            ? "[总是允许]"
            : "[已拒绝]"

        await this.adapter.editMessage(messageId, {
          text: `${statusText}\n━━━━━━━━━━━━━━━━━━━━\n请求 ID: <code>${requestId}</code>`,
          parseMode: "html",
        })
      }

      this.pendingRequests.delete(requestId)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logger.error("Error replying to permission", { error: errorMsg, requestId, value })
      await this.sendMessage({
        text: `<b>发送权限回复失败</b>\n━━━━━━━━━━━━━━━━━━━━\n错误: <code>${this.escapeHtml(errorMsg)}</code>\n请求 ID: <code>${requestId}</code>`,
        parseMode: "html",
      })
    }
  }
  
  // ===== Utilities =====
  
  /**
   * Check if user is authorized
   */
  private isAuthorized(userId: string): boolean {
    // Check admin users
    if (this.config.adminUsers && this.config.adminUsers.length > 0) {
      return this.config.adminUsers.includes(userId)
    }
    return true
  }
  
  /**
   * Send message through adapter
   * Fallback to plain text if HTML parsing fails
   */
  private async sendMessage(message: IMOutgoingMessage): Promise<{ messageId: string }> {
    try {
      return await this.adapter.sendMessage(message)
    } catch (error) {
      // If HTML parsing failed, try sending as plain text
      if (message.parseMode === "html" && error instanceof Error && 
          (error.message.includes("400") || error.message.includes("parse entities"))) {
        this.logger.warn("HTML parsing failed, falling back to plain text", { error: error.message })
        
        // Strip HTML tags for plain text fallback
        const plainText = message.text
          .replace(/<[^>]+>/g, "")  // Remove HTML tags
          .replace(/&lt;/g, "<")    // Unescape HTML entities
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
        
        return await this.adapter.sendMessage({
          ...message,
          text: `[格式渲染失败，以纯文本显示]\n\n${plainText}`,
          parseMode: "plain",
        })
      }
      // Re-throw other errors
      throw error
    }
  }
}
