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
  private lastResponseHashes = new Map<string, string>() // sessionId -> response hash

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
   * Calculate simple hash for text deduplication
   */
  private hashText(text: string): string {
    // Normalize: lowercase, remove extra spaces, trim
    const normalized = text
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
    
    // Simple djb2 hash
    let hash = 5381
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) + hash) + normalized.charCodeAt(i)
      hash = hash & 0xFFFFFFFF // Convert to 32-bit unsigned
    }
    return hash.toString(16)
  }

  /**
   * Check if response is duplicate for this session
   */
  private isDuplicateResponse(sessionId: string, responseText: string): boolean {
    const hash = this.hashText(responseText)
    const lastHash = this.lastResponseHashes.get(sessionId)
    
    if (lastHash === hash) {
      this.logger.info(`Skipping duplicate response for session ${sessionId}`)
      return true
    }
    
    this.lastResponseHashes.set(sessionId, hash)
    return false
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
        case "tui_command":
          await this.handleTuiCommandCallback(callback.user.id, requestId)
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
        case "/cmd":
          await this.sendCommandButtons()
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
   * Send command buttons panel
   */
  private async sendCommandButtons(): Promise<void> {
    const text = `<b>OpenCode 远程控制面板</b>
━━━━━━━━━━━━━━━━━━━━

点击下方按钮执行对应操作：

<b>session_compact</b>
压缩并总结当前会话的历史消息，保留关键信息的同时减少 token 消耗，适合长会话维护。

<b>session_new</b>
创建一个新的 OpenCode 会话，等同于在 TUI 中按 Ctrl+N。新会话将在后台启动。

<b>session_interrupt</b>
立即中断当前正在执行的 AI 任务，等同于在 TUI 中按 Ctrl+C。适用于 AI 陷入死循环或响应时间过长的情况。

<b>生成标题</b>
AI 自动分析对话内容并生成合适的会话标题，便于后续查找和管理。

`

    const keyboard = [
      [
        { text: "session_compact", callbackData: "tui_command:session_compact" },
        { text: "session_new", callbackData: "tui_command:session_new" },
      ],
      [
        { text: "session_interrupt", callbackData: "tui_command:session_interrupt" },
      ],
      [
        { text: "生成标题", callbackData: "tui_command:autotitle" },
      ],
    ]

    await this.sendMessage({
      text,
      keyboard: { inline: keyboard },
      parseMode: "html",
    })
  }

  /**
   * Handle TUI command callback from button click
   */
  private async handleTuiCommandCallback(userId: string, command: string): Promise<void> {
    // Handle autotitle separately
    if (command === "autotitle") {
      await this.executeAutotitle(userId)
      return
    }

    // Map is now 1:1 with API names
    const validCommands = ["session_compact", "session_new", "session_interrupt"]

    if (validCommands.includes(command)) {
      await this.executeTuiCommand(command, userId)
    } else {
      await this.sendMessage({
        text: `<b>未知操作</b>: ${command}`,
        parseMode: "html"
      })
    }
  }

  /**
   * Execute TUI command via OpenCode API
   */
  private async executeTuiCommand(command: string, userId?: string): Promise<void> {
    try {
      // Get the mapping to check if user has selected a session
      const mapping = userId ? this.sessionMappings.get(userId) : undefined
      
      // Use the SDK client's internal _client which has proper fetch configured
      const client = (this.input.client as any)._client || this.input.client

      this.logger.info(`Executing TUI command: ${command}`, { sessionId: mapping?.sessionId })

      // Special handling for session_new - directly create session and get ID
      if (command === "session_new") {
        const result = await client.post({
          url: `/session`,
          body: {
            title: `Remote session ${new Date().toLocaleString("zh-CN")}`,
          },
        })

        if (result.error || !result.data?.id) {
          throw new Error(`Failed to create session: ${JSON.stringify(result.error)}`)
        }

        const newSessionId = result.data.id

        // Auto-select the new session for the user
        if (userId) {
          this.sessionMappings.set(userId, {
            imUserId: userId,
            sessionId: newSessionId,
            lastActivity: Date.now(),
          })
        }

        // Navigate TUI to the new session so it becomes visible and active
        try {
          await client.post({
            url: `/tui/select-session`,
            body: { sessionID: newSessionId },
          })
          this.logger.info(`TUI navigated to new session: ${newSessionId}`)
        } catch (navError) {
          this.logger.warn(`Failed to navigate TUI to new session`, navError)
          // Don't fail the whole operation if navigation fails
        }

        await this.sendMessage({
          text: `<b>✅ 新会话已创建</b>\n━━━━━━━━━━━━━━━━━━━━\n会话 ID: <code>${newSessionId}</code>${userId ? "\n已自动选择此会话" : ""}\n\n现在可以直接发送消息了。`,
          parseMode: "html",
        })

        this.logger.info(`Session created successfully: ${newSessionId}`)
        return
      }

      // Special handling for session_interrupt - use direct abort API instead of TUI command
      if (command === "session_interrupt") {
        if (!mapping?.sessionId) {
          throw new Error("未选择会话，无法中断")
        }

        const response = await client.post({
          url: `/session/${mapping.sessionId}/abort`,
        })

        if (response.error) {
          throw new Error(`API error: ${JSON.stringify(response.error)}`)
        }

        await this.sendMessage({
          text: `<b>✅ 命令执行成功</b>\n━━━━━━━━━━━━━━━━━━━━\n操作: 中断会话\n会话: <code>${mapping.sessionId}</code>`,
          parseMode: "html",
        })

        this.logger.info(`Session interrupted successfully: ${mapping.sessionId}`)
        return
      }

      const response = await client.post({
        url: `/tui/execute-command`,
        body: { command },
      })

      if (response.error) {
        throw new Error(`API error: ${JSON.stringify(response.error)}`)
      }

      const commandNames: Record<string, string> = {
        session_compact: "压缩会话",
        session_new: "新建会话",
        session_interrupt: "中断会话",
      }

      await this.sendMessage({
        text: `<b>✅ 命令执行成功</b>\n━━━━━━━━━━━━━━━━━━━━\n操作: ${commandNames[command] || command}${mapping ? `\n会话: <code>${mapping.sessionId}</code>` : ""}`,
        parseMode: "html",
      })

      this.logger.info(`TUI command executed successfully: ${command}`)
    } catch (error) {
      this.logger.error(`Error executing TUI command: ${command}`, error)
      const errorMsg = error instanceof Error ? error.message : String(error)
      await this.sendMessage({
        text: `<b>❌ 命令执行失败</b>\n━━━━━━━━━━━━━━━━━━━━\n操作: ${command}\n错误: <code>${this.escapeHtml(errorMsg)}</code>`,
        parseMode: "html",
      })
    }
  }

  /**
   * Execute autotitle command - AI generates session title
   */
  private async executeAutotitle(userId: string): Promise<void> {
    try {
      const mapping = this.sessionMappings.get(userId)
      if (!mapping) {
        await this.sendMessage({
          text: "<b>❌ 未选择会话</b>\n\n请先使用 /sessions 选择要生成标题的会话",
          parseMode: "html"
        })
        return
      }

      const sessionId = mapping.sessionId

      // Send "generating" hint
      await this.sendMessage({
        text: `<b>📝 正在生成标题...</b>\n分析会话内容，请稍候`,
        parseMode: "html"
      })

      // Call AI to generate title
      const result = await this.input.client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{
            type: "text",
            text: `[system] 请根据我们的对话内容，生成一个简洁的会话标题（10-20字）。
要求：
1. 准确概括对话核心主题或任务
2. 简洁明了，便于后续查找
3. 只返回标题文字本身，不要有引号、解释或格式`
          }]
        }
      })

      if (result.error) {
        throw new Error(`生成失败: ${JSON.stringify(result.error)}`)
      }

      // Extract generated title
      const generatedTitle = this.extractTextFromAIResponse(result.data)

      if (!generatedTitle || generatedTitle.length < 2) {
        throw new Error("AI 未能生成有效标题")
      }

      // Update session title using underlying client
      const client = (this.input.client as any)._client || this.input.client
      const updateResult = await client.patch({
        url: `/session/${sessionId}`,
        body: { title: generatedTitle }
      })

      if (updateResult.error) {
        throw new Error(`更新标题失败: ${JSON.stringify(updateResult.error)}`)
      }

      // Notify user
      await this.sendMessage({
        text: `<b>✅ 标题已更新</b>\n━━━━━━━━━━━━━━\n新标题：<b>${this.escapeHtml(generatedTitle)}</b>`,
        parseMode: "html"
      })

      this.logger.info(`Session title auto-generated: ${sessionId} -> "${generatedTitle}"`)

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logger.error(`Error executing autotitle`, error)
      await this.sendMessage({
        text: `<b>❌ 生成标题失败</b>\n━━━━━━━━━━━━━━\n错误：${this.escapeHtml(errorMsg)}`,
        parseMode: "html"
      })
    }
  }

  /**
   * Extract text from AI response
   */
  private extractTextFromAIResponse(data: any): string {
    if (!data) return ""

    // Try different response formats
    const text = data.info?.content ||
      data.parts?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("") ||
      data.text ||
      ""

    return text.trim()
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
<b>会话管理：</b>
/sessions - 列出所有会话
/current - 查看当前选中的会话
/use &lt;sessionId&gt; - 选择特定会话
/ask &lt;message&gt; - 向当前会话发送消息

<b>OpenCode 控制命令：</b>
/cmd - 显示控制面板（点击按钮执行操作）

<b>说明：</b>
- /sessions 显示所有会话（按 busy → retry → idle 排序）
- 使用 /use 选择会话后，/ask 会直接向该会话发送消息
- /cmd 命令可以直接调用 OpenCode 的内部功能
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
    
    // Sync TUI to the selected session
    const client = (this.input.client as any)._client || this.input.client
    try {
      await client.post({
        url: `/tui/select-session`,
        body: { sessionID: sessionId },
      })
      this.logger.info(`TUI navigated to selected session: ${sessionId}`)
    } catch (navError) {
      this.logger.warn(`Failed to navigate TUI to selected session`, navError)
    }
    
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
   * Get session prefix for messages
   */
  private async getSessionPrefix(sessionId: string): Promise<string> {
    try {
      const sessionRes = await this.input.client.session.get({ path: { id: sessionId } })
      const title = sessionRes.data?.title || "未命名"
      return `<code>${sessionId}</code>:${this.escapeHtml(title)}`
    } catch {
      return `<code>${sessionId}</code>:未知会话`
    }
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

      // Get session prefix for consistent formatting
      const sessionPrefix = await this.getSessionPrefix(sessionId)

      // Warn if session is not active
      if (sessionStatus === "idle") {
        await this.sendMessage({
          text: `${sessionPrefix}\n` +
                `<b>⚠️ 警告: 会话可能已关闭或不活跃</b>\n` +
                `状态: ${this.getStatusLabel(sessionStatus)}\n\n` +
                `消息仍会尝试发送，但可能无法得到响应。\n` +
                `建议使用 /sessions 选择活跃的会话。`,
          parseMode: "html",
        })
        // Continue anyway but warn user
      }

      // Send initial "processing" message with session prefix
      await this.sendMessage({
        text: `${sessionPrefix}\n<b>⏳ 正在处理请求...</b>`,
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
        // Check for abort/interrupt error
        const errorInfo = response.info?.error
        if (errorInfo) {
          const errorName = errorInfo.name || errorInfo.data?.name
          const errorMessage = errorInfo.data?.message || errorInfo.message || "未知错误"
          
          if (errorName?.includes("Aborted") || errorName?.includes("Interrupt")) {
            await this.sendMessage({
              text: `${sessionPrefix}\n<b>⏹️ 会话已中断</b>\n\n任务被用户手动中断或取消。`,
              parseMode: "html",
            })
            return
          }
          
          // Other errors
          throw new Error(`AI 处理出错: ${errorName} - ${errorMessage}`)
        }
        
        // Try different response formats
        responseText = response.info?.content || 
          response.parts?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ||
          response.text ||
          "AI 已处理请求，但没有返回文本内容。"
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

      // Check for duplicate response before sending
      if (htmlResponse.trim()) {
        const fullResponse = `${sessionPrefix}\n<b>💬 AI 回复</b>\n\n${htmlResponse}`
        
        if (this.isDuplicateResponse(sessionId, fullResponse)) {
          this.logger.info(`Duplicate response detected for session ${sessionId}, skipping send`)
          return
        }
        
        await this.sendMessage({
          text: fullResponse,
          parseMode: "html",
        })
      }
    } catch (error) {
      this.logger.error("Error sending message", error)
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Get session prefix for error message
      let errorPrefix = sessionId ? await this.getSessionPrefix(sessionId) : "未知会话"

      // Fallback: try to send the original response text as plain text
      try {
        if (responseText) {
          await this.adapter.sendMessage({
            text: `${errorPrefix}\n[💬 AI 回复 - 格式渲染失败，显示原始内容]\n\n${responseText}`,
            parseMode: "plain",
          })
        } else {
          throw new Error("No response text available")
        }
      } catch (fallbackError) {
        // If even plain text fails, send error message
        await this.sendMessage({
          text: `${errorPrefix}\n<b>❌ 发送消息失败</b>\n━━━━━━━━━━━━━━━━━━━━\n错误: <code>${this.escapeHtml(errorMessage)}</code>\n\n请检查:\n1. 会话 ID 是否正确\n2. 会话是否仍然活跃\n3. 使用 /sessions 查看可用会话`,
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

    // Fetch session info to display context
    let sessionTitle = "未知会话"
    let sessionDirectory = "未知目录"
    try {
      const sessionRes = await this.input.client.session.get({ path: { id: info.sessionId } })
      const sessionData = sessionRes.data as any
      sessionTitle = sessionData?.title || "未命名会话"
      sessionDirectory = sessionData?.directory || "未知目录"
    } catch (err) {
      this.logger.warn(`Failed to fetch session info for ${info.sessionId}`, err)
    }

    const template = this.config.templates?.question
    const text = template
      ? template(info)
      : this.formatQuestionText(info, sessionTitle, sessionDirectory)

    // Build keyboard from options
    const keyboard = info.questions[0]?.options.map((opt) => [{
      text: opt.label,
      callbackData: `reply:${info.id}:${opt.label}`,
    }])

    // Add reject button
    keyboard?.push([{
      text: "❌ 拒绝回答",
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
  private formatQuestionText(info: QuestionInfo, sessionTitle: string, sessionDirectory: string): string {
    const q = info.questions[0]
    const sessionId = info.sessionId
    let text = `<code>${sessionId}</code>:${this.escapeHtml(sessionTitle)}\n`
    text += `<b>❓ 需要您的确认</b>\n`
    text += `<b>工作目录:</b> <code>${this.escapeHtml(sessionDirectory)}</code>\n`
    text += `━━━━━━━━━━━━━━━━━━━━\n`
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

    // Fetch session info to display context
    let sessionTitle = "未知会话"
    let sessionDirectory = "未知目录"
    try {
      const sessionRes = await this.input.client.session.get({ path: { id: info.sessionId } })
      const sessionData = sessionRes.data as any
      sessionTitle = sessionData?.title || "未命名会话"
      sessionDirectory = sessionData?.directory || "未知目录"
    } catch (err) {
      this.logger.warn(`Failed to fetch session info for ${info.sessionId}`, err)
    }

    const template = this.config.templates?.permission
    const text = template
      ? template(info)
      : this.formatPermissionText(info, sessionTitle, sessionDirectory)

    const keyboard = [[
      { text: "✅ 允许一次", callbackData: `permission:${info.id}:once` },
      { text: "🔓 总是允许", callbackData: `permission:${info.id}:always` },
    ], [
      { text: "❌ 拒绝", callbackData: `permission:${info.id}:reject` },
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
  private formatPermissionText(info: PermissionInfo, sessionTitle: string, sessionDirectory: string): string {
    const sessionId = info.sessionId
    let text = `<code>${sessionId}</code>:${this.escapeHtml(sessionTitle)}\n`
    text += `<b>🔒 权限请求</b>\n`
    text += `<b>工作目录:</b> <code>${this.escapeHtml(sessionDirectory)}</code>\n`
    text += `━━━━━━━━━━━━━━━━━━━━\n`
    text += `<b>请求工具:</b> <code>${info.permission}</code>\n`
    text += `<b>路径:</b>\n`
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
使用 /use &lt;完整ID&gt; 选择此会话`

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
