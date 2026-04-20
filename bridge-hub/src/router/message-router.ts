import type { InstanceRegistry } from '../server/websocket-server.js'
import type { IMAdapter, IMMessage, IMCallbackQuery, IMOutgoingMessage, IMKeyboard, RecentCombo } from '../types/index.js'
import { markdownToEntities, splitEntities } from '../core/markdown-entities.js'

// 正在处理的消息信息
interface PendingMessage {
  chatId: number
  messageId: string
  instanceId: string
  sessionId: string
  sessionTitle: string
  timestamp: number
}

// /go 命令消息上下文（用于原地更新）
interface GoMessageContext {
  chatId: number
  messageId: string
  comboMap: Map<string, RecentCombo> // shortId -> combo
}

// 待处理的权限请求
interface PendingPermission {
  chatId: number
  messageId: string
  instanceId: string
  sessionId: string
  timestamp: number
}

export class MessageRouter {
  private registry: InstanceRegistry
  private adapter: IMAdapter
  private adminUsers: Set<string>
  private allowedChats: Set<string>
  private pendingMessages: Map<string, PendingMessage> = new Map() // messageId -> info
  private pendingPermissions: Map<string, PendingPermission> = new Map() // requestId -> info
  private userChatMap: Map<string, number> = new Map() // userId -> chatId
  private userRecentCombos: Map<string, RecentCombo[]> = new Map() // userId -> combos
  private goMessageContexts: Map<string, GoMessageContext> = new Map() // userId -> context
  private lastResponseHashes: Map<string, string> = new Map() // sessionId -> hash
  private readonly MAX_RECENT_COMBOS = 5

  constructor(
    registry: InstanceRegistry,
    adapter: IMAdapter,
    adminUsers: string[] = [],
    allowedChats: string[] = []
  ) {
    this.registry = registry
    this.adapter = adapter
    this.adminUsers = new Set(adminUsers)
    this.allowedChats = new Set(allowedChats)

    // 定期清理过期的 pending messages
    setInterval(() => this.cleanupPendingMessages(), 300000) // 5分钟
  }

  // 清理过期的 pending messages
  private cleanupPendingMessages(): void {
    const now = Date.now()
    for (const [id, info] of this.pendingMessages.entries()) {
      if (now - info.timestamp > 600000) { // 10分钟过期
        this.pendingMessages.delete(id)
      }
    }
    // 清理过期的 pending permissions
    for (const [id, info] of this.pendingPermissions.entries()) {
      if (now - info.timestamp > 600000) { // 10分钟过期
        this.pendingPermissions.delete(id)
      }
    }
  }

  // 计算文本的简单哈希（用于重复检测）
  private hashText(text: string): string {
    // 标准化：小写、移除多余空格、trim
    const normalized = text
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()

    // 简单的 djb2 哈希
    let hash = 5381
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) + hash) + normalized.charCodeAt(i)
      hash = hash & 0xFFFFFFFF // 转为 32 位无符号整数
    }
    return hash.toString(16)
  }

  // 检查是否为重复响应
  private isDuplicateResponse(sessionId: string, responseText: string): boolean {
    const hash = this.hashText(responseText)
    const lastHash = this.lastResponseHashes.get(sessionId)

    if (lastHash === hash) {
      console.log(`[MessageRouter] Duplicate response detected for session ${sessionId}, skipping`)
      return true
    }

    this.lastResponseHashes.set(sessionId, hash)
    return false
  }

  // 记录最近使用的组合
  private recordRecentCombo(userId: string, instanceId: string, instanceName: string, sessionId: string, sessionTitle: string): void {
    let combos = this.userRecentCombos.get(userId) || []
    
    // 查找是否已存在相同组合
    const existingIndex = combos.findIndex(c => 
      c.instanceId === instanceId && c.sessionId === sessionId
    )
    
    if (existingIndex >= 0) {
      // 更新已存在的组合
      combos[existingIndex].lastUsedAt = Date.now()
      combos[existingIndex].useCount++
      // 移到最前面
      const combo = combos.splice(existingIndex, 1)[0]
      combos.unshift(combo)
    } else {
      // 添加新组合
      combos.unshift({
        instanceId,
        instanceName,
        sessionId,
        sessionTitle,
        lastUsedAt: Date.now(),
        useCount: 1
      })
      
      // 限制数量
      if (combos.length > this.MAX_RECENT_COMBOS) {
        combos = combos.slice(0, this.MAX_RECENT_COMBOS)
      }
    }
    
    this.userRecentCombos.set(userId, combos)
  }

  // 获取用户可用的最近组合（过滤掉已断开的实例）
  private getAvailableRecentCombos(userId: string): RecentCombo[] {
    const allCombos = this.userRecentCombos.get(userId) || []
    const connectedInstanceIds = new Set(this.registry.getAllInstances().map(i => i.id))
    
    // 只返回实例仍然在线的组合
    return allCombos.filter(combo => connectedInstanceIds.has(combo.instanceId))
  }

  // 生成组合按钮文本
  private generateComboButtonText(combo: RecentCombo): string {
    // 缩写：实例名取前 12 字符，会话名取前 15 字符
    const instAbbr = combo.instanceName.length > 12
      ? combo.instanceName.slice(0, 10) + '..'
      : combo.instanceName
    const sessAbbr = combo.sessionTitle.length > 15
      ? combo.sessionTitle.slice(0, 13) + '..'
      : combo.sessionTitle

    return `${instAbbr}|${sessAbbr}`
  }

  // 格式化时间显示
  private formatTimeAgo(timestamp: number): string {
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes}分钟前`
    if (hours < 24) return `${hours}小时前`
    return `${days}天前`
  }

  // 检查用户是否有权限
  private isUserAuthorized(userId: string): boolean {
    if (this.adminUsers.size === 0) {
      return true
    }
    return this.adminUsers.has(userId)
  }

  // 检查 chat/group 是否有权限
  private isChatAuthorized(chatId: number): boolean {
    if (this.allowedChats.size === 0) {
      return true
    }
    return this.allowedChats.has(chatId.toString())
  }

  // 检查是否授权（组合检查）
  private isAuthorized(message: IMMessage): boolean {
    const userAuthorized = this.isUserAuthorized(message.user.id)
    const chatAuthorized = this.isChatAuthorized(message.chatId)
    return userAuthorized && chatAuthorized
  }

  // 处理消息
  async handleMessage(message: IMMessage): Promise<void> {
    // 检查权限（用户 + chat）
    if (!this.isAuthorized(message)) {
      console.log(`Unauthorized access attempt: user=${message.user.id}, chat=${message.chatId}`)
      return
    }

    // 保存用户 chat ID（用于后续事件通知）
    this.userChatMap.set(message.user.id, message.chatId)

    const text = message.text.trim()

    // 处理命令
    if (text.startsWith('/')) {
      await this.handleCommand(text, message.user.id, message.chatId)
      return
    }

    // 普通消息：转发到用户选中的实例
    await this.handleDirectMessage(text, message.user.id, message.chatId)
  }

  // 处理回调
  async handleCallback(callback: IMCallbackQuery): Promise<void> {
    if (!this.isUserAuthorized(callback.user.id)) {
      if ('answerCallbackQuery' in this.adapter) {
        await (this.adapter as any).answerCallbackQuery(callback.id, '未经授权')
      }
      return
    }

    const data = callback.data
    const parts = data.split(':')
    const action = parts[0]

    switch (action) {
      case 'select_instance':
        const instanceId = parts[1]
        const success = this.registry.setUserInstance(callback.user.id, instanceId)

        if ('answerCallbackQuery' in this.adapter) {
          await (this.adapter as any).answerCallbackQuery(
            callback.id,
            success ? `已切换到: ${instanceId}` : '切换失败'
          )
        }

        if (success) {
          // 清除之前选择的 session
          this.registry.clearUserSession(callback.user.id)

          await this.sendMarkdownWithEntities(
            callback.chatId,
            `**已选择实例**: ${instanceId}`,
            '',
            '请使用 /sessions 查看并选择要使用的 session。'
          )
        }
        break

      case 'select_session':
        const sessionId = parts[1]
        const userInstance = this.registry.getUserInstance(callback.user.id)

        if (!userInstance) {
          if ('answerCallbackQuery' in this.adapter) {
            await (this.adapter as any).answerCallbackQuery(callback.id, '请先选择实例')
          }
          return
        }

        this.registry.setUserSession(callback.user.id, sessionId)

        // 获取会话标题并记录到最近组合
        const sessionTitle = await this.getSessionTitle(userInstance.id, sessionId)
        this.recordRecentCombo(
          callback.user.id,
          userInstance.id,
          userInstance.workspace.split('/').pop() || userInstance.id,
          sessionId,
          sessionTitle
        )

        if ('answerCallbackQuery' in this.adapter) {
          await (this.adapter as any).answerCallbackQuery(callback.id, `已选择 session`)
        }

        await this.sendMarkdownWithEntities(
          callback.chatId,
          `**已选择 Session**: \`${sessionId}\``,
          '',
          `实例: **${userInstance.id}**\n\n现在可以直接发送消息了。`
        )
        break

      case 'tui_command':
        const command = parts[1]
        await this.handleTuiCommand(callback.user.id, command, callback.id, callback.chatId, callback.messageId)
        break

      case 'reply':
        // 问题回复，转发到对应实例
        await this.handleQuestionReply(callback.user.id, parts[1], parts[2])
        break

      case 'permission':
        // 权限回复，转发到对应实例
        await this.handlePermissionReply(callback.user.id, parts[1], parts[2] as 'once' | 'always' | 'reject')
        break

      case 'select_combo':
        // 选择组合（实例+会话）- 使用短ID
        const shortId = parts[1]
        await this.handleSelectCombo(
          callback.user.id,
          shortId,
          callback.id,
          callback.chatId,
          callback.messageId
        )
        break
    }
  }

  // 处理命令
  private async handleCommand(text: string, userId: string, chatId: number): Promise<void> {
    const parts = text.split(' ')
    const command = parts[0].toLowerCase()
    const args = parts.slice(1)

    switch (command) {
      case '/start':
      case '/help':
        await this.sendHelp(chatId)
        break

      case '/instances':
        await this.listInstances(chatId)
        break

      case '/use':
        if (args.length === 0) {
          await this.sendMarkdownWithEntities(chatId, '❌ **请提供实例 ID**', '', '用法: `/use <instance-id>`')
          return
        }
        await this.selectInstance(userId, chatId, args[0])
        break

      case '/current':
        await this.showCurrentInstance(userId, chatId)
        break

      case '/sessions':
        await this.listSessions(userId, chatId)
        break

      case '/cmd':
        await this.sendCommandPanel(userId, chatId)
        break

      case '/go':
        await this.showRecentCombos(userId, chatId)
        break

      default:
        await this.sendMarkdownWithEntities(chatId, `❓ **未知命令**: ${command}`, '', '使用 /help 查看可用命令')
    }
  }

  // 发送帮助信息（使用 entities 模式）
  private async sendHelp(chatId: number): Promise<void> {
    const text = `
**OpenCode Bridge Hub**
━━━━━━━━━━━━━━

**可用命令：**
/instances - 列出所有连接的实例
/use <id> - 选择实例
/sessions - 列出当前实例的所有 sessions
/go - 快速切换到最近使用的会话
/current - 查看当前选中的实例和 session
/cmd - 打开远程控制面板
/help - 显示此帮助

**使用方法：**
1. 使用 /instances 查看可用实例
2. 点击按钮选择实例
3. 使用 /sessions 查看该实例的 sessions
4. 点击按钮选择 session
5. 直接发送消息与选中的 session 交互

**快速切换：**
使用 /go 可快速切换到最近使用过的 5 个会话组合
    `.trim()

    await this.sendMarkdownWithEntities(chatId, text, '', '')
  }

  // 发送远程控制面板
  private async sendCommandPanel(userId: string, chatId: number): Promise<void> {
    const instance = this.registry.getUserInstance(userId)
    const sessionId = this.registry.getUserSession(userId)

    // 获取当前实例和 session 信息（统一代码块格式）
    let headerText = '**OpenCode 远程控制面板**\n──────────────\n\n'
    if (instance) {
      headerText += `**INSTANCE:** \`${instance.id}\`\n`
      if (sessionId) {
        const sessionTitle = await this.getSessionTitle(instance.id, sessionId)
        headerText += `**TITLE:** \`${sessionTitle}\`\n`
        headerText += `**SESSION ID:** \`${sessionId}\`\n`
      }
      headerText += '\n'
    }

    const text = headerText + `**session new** - 创建新 session
**session compact** - 压缩当前 session
**session interrupt** - 中断当前任务

点击按钮执行对应操作：`

    const keyboard: IMKeyboard = {
      inline: [
        [
          { text: 'session new', callbackData: 'tui_command:session_new' },
          { text: 'session compact', callbackData: 'tui_command:session_compact' }
        ],
        [
          { text: 'session interrupt', callbackData: 'tui_command:session_interrupt' }
        ]
      ]
    }

    await this.sendMarkdownWithEntities(
      chatId,
      text,
      '',
      '',
      { keyboard }
    )
  }

  // 处理 TUI 命令
  private async handleTuiCommand(userId: string, command: string, callbackId: string, chatId: number, messageId?: string): Promise<void> {
    const instance = this.registry.getUserInstance(userId)
    let sessionId = this.registry.getUserSession(userId)

    if (!instance) {
      if ('answerCallbackQuery' in this.adapter) {
        await (this.adapter as any).answerCallbackQuery(callbackId, '请先选择实例')
      }
      return
    }

    // 除了 session_new 外，其他命令需要选择 session
    if (command !== 'session_new' && !sessionId) {
      if ('answerCallbackQuery' in this.adapter) {
        await (this.adapter as any).answerCallbackQuery(callbackId, '请先选择 session')
      }
      return
    }

    try {
      // 发送请求到 Plugin 执行命令
      const response = await this.registry.sendToInstance(instance.id, {
        type: 'command',
        command: 'tui_command',
        subCommand: command,
        sessionId
      })

      if ('answerCallbackQuery' in this.adapter) {
        if (response.error) {
          await (this.adapter as any).answerCallbackQuery(callbackId, `执行失败`)
          // 错误时发送新消息
          const errorResult = markdownToEntities(`**命令执行失败**\n\n操作: ${command}\n错误: ${response.error}`)
          await this.sendMessage({
            chatId: chatId,
            text: errorResult.text,
            parseMode: 'entities',
            entities: errorResult.entities
          })
        } else {
          await (this.adapter as any).answerCallbackQuery(callbackId, `执行成功`)

          // 特殊处理 session_new - 自动切换到新 session
          if (command === 'session_new' && response.sessionId) {
            this.registry.setUserSession(userId, response.sessionId)
            sessionId = response.sessionId
          }

          // 构建结果消息（统一代码块格式）
          const sessionTitle = sessionId ? await this.getSessionTitle(instance.id, sessionId) : '未命名'
          let resultText = `**OpenCode 远程控制面板**\n──────────────\n\n`
          resultText += `**INSTANCE:** \`${instance.id}\`\n`
          if (sessionId) {
            resultText += `**TITLE:** \`${sessionTitle}\`\n`
            resultText += `**SESSION ID:** \`${sessionId}\`\n`
          }
          resultText += `\n**命令执行成功**\n\n操作: ${command}`

          if (command === 'session_new' && response.sessionId) {
            resultText += `\n\n已自动切换到新 session。`
          }

          // 转换为 entities
          const result = markdownToEntities(resultText)

          // 如果有 messageId，编辑原消息移除按钮；否则发送新消息
          if (messageId && this.adapter.editMessage) {
            await this.adapter.editMessage(messageId, {
              chatId,
              text: result.text,
              parseMode: 'entities',
              entities: result.entities
            })
          } else {
            await this.sendMessage({
              chatId: chatId,
              text: result.text,
              parseMode: 'entities',
              entities: result.entities
            })
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      if ('answerCallbackQuery' in this.adapter) {
        await (this.adapter as any).answerCallbackQuery(callbackId, '执行失败')
      }
      const errorResult = markdownToEntities(`**命令执行失败**\n\n操作: ${command}\n错误: ${errorMsg}`)
      await this.sendMessage({
        chatId: chatId,
        text: errorResult.text,
        parseMode: 'entities',
        entities: errorResult.entities
      })
    }
  }

  // 处理来自实例的事件（question.asked, permission.asked）
  async handleInstanceEvent(instanceId: string, eventType: string, data: any): Promise<void> {
    console.log(`[MessageRouter] Handling event: ${eventType} from ${instanceId}`)

    switch (eventType) {
      case 'question.asked':
        await this.handleQuestionAsked(instanceId, data)
        break
      case 'permission.asked':
        await this.handlePermissionAsked(instanceId, data)
        break
      default:
        console.log(`[MessageRouter] Unknown event type: ${eventType}`)
    }
  }

  // 处理 question.asked 事件
  private async handleQuestionAsked(instanceId: string, data: any): Promise<void> {
    const { id, sessionId, questions } = data
    const question = questions?.[0]

    if (!question) {
      console.error('[MessageRouter] No question data received')
      return
    }

    // 获取 session 标题
    const sessionTitle = await this.getSessionTitle(instanceId, sessionId)

    // 构建消息文本（统一代码块格式）
    let text = `**INSTANCE:** \`${instanceId}\`\n**TITLE:** \`${sessionTitle}\`\n**SESSION ID:** \`${sessionId}\`\n\n`
    text += `🦀 **蟹老板需要您的确认：**\n\n`
    text += `**${question.header}**\n\n`
    text += `${question.question}\n\n`

    if (question.options?.length > 0) {
      text += `**选项:**\n`
      question.options.forEach((opt: any, idx: number) => {
        text += `${idx + 1}. **${opt.label}**: ${opt.description}\n`
      })
    }

    // 构建键盘
    const keyboard: IMKeyboard = { inline: [] }
    if (question.options?.length > 0) {
      question.options.forEach((opt: any) => {
        keyboard.inline.push([{
          text: opt.label,
          callbackData: `reply:${id}:${opt.label}`
        }])
      })
    }
    // 添加拒绝按钮
    keyboard.inline.push([{
      text: '拒绝回答',
      callbackData: `reply:${id}:__reject__`
    }])

    const chatId = this.getDefaultChatId()
    if (!chatId) {
      console.error('[MessageRouter] Cannot send question: no chat ID available')
      return
    }

    try {
      const entityResult = markdownToEntities(text)
      const result = await this.sendMessage({
        chatId,
        text: entityResult.text,
        parseMode: 'entities',
        entities: entityResult.entities,
        replyMarkup: keyboard
      })

      // 保存到 pending messages
      this.pendingMessages.set(id, {
        chatId,
        messageId: result.messageId,
        instanceId,
        sessionId,
        sessionTitle,
        timestamp: Date.now()
      })

      console.log(`[MessageRouter] Question sent: ${id}, messageId: ${result.messageId}`)
    } catch (err) {
      console.error('[MessageRouter] Error sending question:', err)
    }
  }

  // 处理 permission.asked 事件
  private async handlePermissionAsked(instanceId: string, data: any): Promise<void> {
    const { id, sessionId, permission, patterns } = data

    // 获取 session 标题
    const sessionTitle = await this.getSessionTitle(instanceId, sessionId)

    // 构建消息文本（统一代码块格式）
    let text = `**INSTANCE:** \`${instanceId}\`\n**TITLE:** \`${sessionTitle}\`\n**SESSION ID:** \`${sessionId}\`\n\n`
    text += `🦀 **蟹老板请求权限：**\n\n`
    text += `**权限:** ${permission}\n\n`

    if (patterns?.length > 0) {
      text += `**路径:**\n`
      patterns.forEach((pattern: string, idx: number) => {
        text += `${idx + 1}. \`${pattern}\`\n`
      })
    }

    // 构建键盘
    const keyboard: IMKeyboard = {
      inline: [
        [
          { text: '允许一次', callbackData: `permission:${id}:once` },
          { text: '总是允许', callbackData: `permission:${id}:always` }
        ],
        [
          { text: '拒绝', callbackData: `permission:${id}:reject` }
        ]
      ]
    }

    const chatId = this.getDefaultChatId()
    if (!chatId) {
      console.error('[MessageRouter] Cannot send permission request: no chat ID available')
      return
    }

    try {
      const entityResult = markdownToEntities(text)
      const result = await this.sendMessage({
        chatId,
        text: entityResult.text,
        parseMode: 'entities',
        entities: entityResult.entities,
        replyMarkup: keyboard
      })

      // 保存到 pending permissions
      this.pendingPermissions.set(id, {
        chatId,
        messageId: result.messageId,
        instanceId,
        sessionId,
        timestamp: Date.now()
      })

      console.log(`[MessageRouter] Permission request sent: ${id}, messageId: ${result.messageId}`)
    } catch (err) {
      console.error('[MessageRouter] Error sending permission request:', err)
    }
  }

  // 获取默认 chat ID（用于发送事件消息）
  private getDefaultChatId(): number | null {
    // 获取第一个已知用户的 chat ID
    for (const chatId of this.userChatMap.values()) {
      return chatId
    }

    console.warn('[MessageRouter] No chat ID available for sending event')
    return null
  }

  // 发送消息的辅助方法
  private async sendMessage(message: IMOutgoingMessage): Promise<{ messageId: string }> {
    return this.adapter.sendMessage(message)
  }

  /**
   * 发送 Markdown 消息（支持 entities 和长消息分片）
   * 统一封装的消息发送方法
   */
  private async sendMarkdownWithEntities(
    chatId: number,
    infoSection: string,
    crabPrefix: string,
    content: string,
    options?: {
      keyboard?: IMKeyboard
      editMessageId?: string
    }
  ): Promise<void> {
    // 构建完整 Markdown 文本
    const fullMarkdown = `${infoSection}\n──────────────\n${crabPrefix}\n\n${content}`

    // 转换为 entities
    const result = markdownToEntities(fullMarkdown)

    // 分割长消息（Telegram 限制 4096 字符）
    const chunks = splitEntities(result.text, result.entities, 4096)

    // 发送消息
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const isFirstChunk = i === 0
      const isLastChunk = i === chunks.length - 1

      const message: IMOutgoingMessage = {
        chatId,
        text: chunk.text,
        parseMode: 'entities',
        entities: chunk.entities
      }

      // 只在最后一个块添加键盘
      if (isLastChunk && options?.keyboard) {
        message.replyMarkup = options.keyboard
      }

      if (isFirstChunk && options?.editMessageId && this.adapter.editMessage) {
        // 编辑现有消息
        await this.adapter.editMessage(options.editMessageId, message)
      } else {
        // 发送新消息
        await this.sendMessage(message)
      }
    }
  }
}
