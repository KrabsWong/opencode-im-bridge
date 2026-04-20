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

export class MessageRouter {
  private registry: InstanceRegistry
  private adapter: IMAdapter
  private adminUsers: Set<string>
  private allowedChats: Set<string>
  private pendingMessages: Map<string, PendingMessage> = new Map() // messageId -> info
  private userChatMap: Map<string, number> = new Map() // userId -> chatId
  private userRecentCombos: Map<string, RecentCombo[]> = new Map() // userId -> combos
  private goMessageContexts: Map<string, GoMessageContext> = new Map() // userId -> context
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

          await this.sendMessage({
            chatId: callback.chatId,
            text: `**已选择实例**: ${instanceId}\n\n请使用 /sessions 查看并选择要使用的 session。`,
            parseMode: 'entities'
          })
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

        await this.sendMessage({
          chatId: callback.chatId,
          text: `**已选择 Session**: \`${sessionId}\`\n\n实例: **${userInstance.id}**\n\n现在可以直接发送消息了。`,
          parseMode: 'entities'
        })
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
          await this.sendMessage({
            chatId,
            text: '❌ **请提供实例 ID**\n用法: `/use <instance-id>`',
            parseMode: 'entities'
          })
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
        await this.sendMessage({
          chatId,
          text: `❓ **未知命令**: ${command}\n使用 /help 查看可用命令`,
          parseMode: 'entities'
        })
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

    await this.sendMessage({
      chatId,
      text,
      parseMode: 'entities'
    })
  }

  // 发送远程控制面板
  private async sendCommandPanel(userId: string, chatId: number): Promise<void> {
    const instance = this.registry.getUserInstance(userId)
    const sessionId = this.registry.getUserSession(userId)

    // 获取当前实例和 session 信息
    let headerText = '**OpenCode 远程控制面板**\n---\n\n'
    if (instance) {
      headerText += `instance: ${instance.id}\n`
      if (sessionId) {
        const sessionTitle = await this.getSessionTitle(instance.id, sessionId)
        headerText += `${sessionTitle}:\`${sessionId}\`\n`
      }
      headerText += '\n'
    }

    const text = headerText + `**session new** - 创建新 session
**session compact** - 压缩当前 session
**session interrupt** - 中断当前任务
**autotitle** - AI 自动生成标题

点击按钮执行对应操作：`

    const keyboard: IMKeyboard = {
      inline: [
        [
          { text: 'session new', callbackData: 'tui_command:session_new' },
          { text: 'session compact', callbackData: 'tui_command:session_compact' }
        ],
        [
          { text: 'session interrupt', callbackData: 'tui_command:session_interrupt' },
          { text: 'autotitle', callbackData: 'tui_command:autotitle' }
        ]
      ]
    }

    await this.sendMessage({
      chatId,
      text,
      parseMode: 'entities',
      replyMarkup: keyboard
    })
  }

  // 显示最近使用的组合
  private async showRecentCombos(userId: string, chatId: number): Promise<void> {
    const availableCombos = this.getAvailableRecentCombos(userId)

    if (availableCombos.length === 0) {
      await this.sendMessage({
        chatId,
        text: '🚀 **快速切换**\n\n暂无最近使用的会话组合。\n\n请先使用 /instances 开始。',
        parseMode: 'entities'
      })
      return
    }

    let text = '🚀 **快速切换**\n\n最近使用的会话组合：\n\n'

    // 在文字中详细展示所有组合
    availableCombos.forEach((combo, index) => {
      const timeAgo = this.formatTimeAgo(combo.lastUsedAt)
      text += `${index + 1}. **${combo.instanceName}**\n`
      text += `   会话: ${combo.sessionTitle}\n`
      text += `   使用: ${timeAgo} (${combo.useCount}次)\n\n`
    })

    text += '点击按钮快速切换：'

    const keyboard: IMKeyboard = { inline: [] }
    const comboMap = new Map<string, RecentCombo>()

    // 每行放 2 个按钮
    // 使用短ID映射而不是索引，避免实例断开导致索引错位
    for (let i = 0; i < availableCombos.length; i += 2) {
      const row: typeof keyboard.inline[0] = []

      for (let j = i; j < Math.min(i + 2, availableCombos.length); j++) {
        const combo = availableCombos[j]
        const buttonText = this.generateComboButtonText(combo)
        // 生成短ID：实例名首字母+会话名首字母+索引（如 p-m-0）
        const shortId = `${combo.instanceName.charAt(0)}-${combo.sessionTitle.charAt(0)}-${j}`
        comboMap.set(shortId, combo)
        row.push({
          text: buttonText,
          callbackData: `select_combo:${shortId}`
        })
      }

      keyboard.inline.push(row)
    }

    const result = await this.sendMessage({
      chatId,
      text,
      parseMode: 'entities',
      replyMarkup: keyboard
    })

    // 保存消息上下文和映射表，用于后续点击查找
    this.goMessageContexts.set(userId, {
      chatId,
      messageId: result.messageId,
      comboMap
    })
  }

  // 列出所有实例
  private async listInstances(chatId: number): Promise<void> {
    const instances = this.registry.getAllInstances()

    if (instances.length === 0) {
      await this.sendMessage({
        chatId,
        text: '**当前没有连接的实例**',
        parseMode: 'entities'
      })
      return
    }

    let text = '**所有实例**\n\n'

    const keyboard: IMKeyboard = { inline: [] }

    instances.forEach((instance, index) => {
      const statusText = instance.status === 'connected' ? '[已连接]' : '[已断开]'
      text += `${index + 1}. \`${instance.id}\`\n`
      text += `   目录: ${instance.workspace}\n`
      text += `   状态: ${statusText}\n\n`

      keyboard.inline.push([{
        text: `选择: ${instance.id.slice(0, 20)}`,
        callbackData: `select_instance:${instance.id}`
      }])
    })

    await this.sendMessage({
      chatId,
      text,
      parseMode: 'entities',
      replyMarkup: keyboard
    })
  }

  // 选择实例
  private async selectInstance(userId: string, chatId: number, instanceId: string): Promise<void> {
    const success = this.registry.setUserInstance(userId, instanceId)

    if (success) {
      // 清除之前选择的 session
      this.registry.clearUserSession(userId)

      await this.sendMessage({
        chatId,
        text: `**已选择实例**: \`${instanceId}\`\n\n请使用 /sessions 查看并选择要使用的 session。`,
        parseMode: 'entities'
      })
    } else {
      await this.sendMessage({
        chatId,
        text: `**实例不存在**: \`${instanceId}\`\n\n使用 /instances 查看可用实例。`,
        parseMode: 'entities'
      })
    }
  }

  // 显示当前选中的实例
  private async showCurrentInstance(userId: string, chatId: number): Promise<void> {
    const context = this.registry.getUserContext(userId)

    if (!context.selectedInstanceId) {
      await this.sendMessage({
        chatId,
        text: '**当前没有选择实例**\n\n使用 /instances 查看并选择实例。',
        parseMode: 'entities'
      })
      return
    }

    const instance = this.registry.getInstance(context.selectedInstanceId)

    if (!instance) {
      await this.sendMessage({
        chatId,
        text: `**之前选择的实例** \`${context.selectedInstanceId}\` 已断开连接。\n\n请使用 /instances 重新选择。`,
        parseMode: 'entities'
      })
      return
    }

    let text = `**当前实例**\n\nID: \`${instance.id}\`\n目录: ${instance.workspace}\n状态: ${instance.status}`

    if (context.selectedSessionId) {
      text += `\n\n**当前 Session**: \`${context.selectedSessionId}\``
    } else {
      text += `\n\n**未选择 Session**\n使用 /sessions 查看可用 sessions。`
    }

    await this.sendMessage({
      chatId,
      text,
      parseMode: 'entities'
    })
  }

  // 列出当前实例的所有 sessions
  private async listSessions(userId: string, chatId: number): Promise<void> {
    const instance = this.registry.getUserInstance(userId)

    if (!instance) {
      await this.sendMessage({
        chatId,
        text: '**请先选择实例**\n\n使用 /instances 查看可用实例。',
        parseMode: 'entities'
      })
      return
    }

    // 发送请求获取 sessions 列表
    try {
      const response = await this.registry.sendToInstance(instance.id, {
        type: 'command',
        command: 'list_sessions'
      })

      if (response.error) {
        await this.sendMessage({
          chatId,
          text: `**获取 Sessions 失败**\n\n${response.error}`,
          parseMode: 'entities'
        })
        return
      }

      const sessions = response.sessions || []

      if (sessions.length === 0) {
        await this.sendMessage({
          chatId,
          text: '**当前实例没有 Sessions**\n\n请在 OpenCode 中创建新 session。',
          parseMode: 'entities'
        })
        return
      }

      let text = `**instance:** ${instance.id}\n**Sessions:**\n\n`
      const keyboard: IMKeyboard = { inline: [] }

      sessions.forEach((session: any, index: number) => {
        const statusText = session.status === 'waiting_user_input' ? '[等待输入]' :
                           session.status === 'working' ? '[执行中]' : '[空闲]'
        const todoInfo = session.todoCount > 0 ? ` [${session.completedCount}/${session.todoCount}]` : ''
        const displayTitle = session.title || '未命名'

        // 列表显示格式: <title>:`<sessionId>`
        text += `${index + 1}. ${statusText} ${displayTitle}:\`${session.id}\`${todoInfo}\n`

        // 按钮显示标题，如果标题太长则截断
        const buttonText = displayTitle.length > 30
          ? `${displayTitle.slice(0, 27)}...${todoInfo}`
          : `${displayTitle}${todoInfo}`

        keyboard.inline.push([{
          text: buttonText,
          callbackData: `select_session:${session.id}`
        }])
      })

      text += '\n点击按钮选择要使用的 session。'

      await this.sendMessage({
        chatId,
        text,
        parseMode: 'entities',
        replyMarkup: keyboard
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      await this.sendMessage({
        chatId,
        text: `**获取 Sessions 失败**\n\n${errorMsg}`,
        parseMode: 'entities'
      })
    }
  }

  // 处理直接消息
  private async handleDirectMessage(text: string, userId: string, chatId: number): Promise<void> {
    const instance = this.registry.getUserInstance(userId)

    if (!instance) {
      await this.sendMessage({
        chatId,
        text: '**请先选择实例**\n\n使用 /instances 查看可用实例。',
        parseMode: 'entities'
      })
      return
    }

    // 获取用户选择的 session
    let sessionId = this.registry.getUserSession(userId)
    let autoCreated = false

    // 如果没有选择 session，尝试获取或创建
    if (!sessionId) {
      // 先尝试获取最新的 session
      const listResponse = await this.registry.sendToInstance(instance.id, {
        type: 'command',
        command: 'list_sessions'
      })
      
      if (listResponse.sessions && listResponse.sessions.length > 0) {
        // 使用最新的 session
        const latestSession = listResponse.sessions[0]
        sessionId = latestSession.id
        this.registry.setUserSession(userId, sessionId!)
      } else {
        // 没有 session，自动创建
        const createResponse = await this.registry.sendToInstance(instance.id, {
          type: 'command',
          command: 'tui_command',
          subCommand: 'session_new'
        })
        
        if (createResponse.error || !createResponse.sessionId) {
          await this.sendMessage({
            chatId,
            text: `**创建 Session 失败**\n\n${createResponse.error || '未知错误'}`,
            parseMode: 'entities'
          })
          return
        }
        
        sessionId = createResponse.sessionId
        this.registry.setUserSession(userId, sessionId!)
        autoCreated = true
      }
    }

    // 此时 sessionId 一定存在
    if (!sessionId) {
      await this.sendMessage({
        chatId,
        text: `**Session 获取失败**\n\n无法获取或创建 session`,
        parseMode: 'entities'
      })
      return
    }

    // 获取 session 标题
    const sessionTitle = await this.getSessionTitle(instance.id, sessionId)

    // 记录到最近组合
    this.recordRecentCombo(
      userId,
      instance.id,
      instance.workspace.split('/').pop() || instance.id,
      sessionId,
      sessionTitle
    )

    // 构建消息前缀（分三行：instance、title、sessionId）
    const infoSection = `instance: ${instance.id}\nTitle: ${sessionTitle}\nSession Id: \`${sessionId}\``

    // 发送"处理中"消息
    const processingText = autoCreated
      ? `${infoSection}\n---\n🦀 **蟹老板说**\n\n**已自动创建新 Session，正在处理请求...**`
      : `${infoSection}\n---\n🦀 **蟹老板说**\n\n**正在处理请求...**`
    const processingResult = markdownToEntities(processingText)
    const processingMsg = await this.sendMessage({
      chatId,
      text: processingResult.text,
      parseMode: 'entities',
      entities: processingResult.entities
    })

    // 记录正在处理的消息（防止切换选择后收不到响应）
    this.pendingMessages.set(processingMsg.messageId, {
      chatId,
      messageId: processingMsg.messageId,
      instanceId: instance.id,
      sessionId,
      sessionTitle,
      timestamp: Date.now()
    })

    try {
      // 转发到实例，指定 session
      const response = await this.registry.sendToInstance(instance.id, {
        type: 'prompt',
        text,
        userId,
        chatId,
        sessionId  // 使用选中的 session
      })

      // 从 pending 中移除
      this.pendingMessages.delete(processingMsg.messageId)

      // 格式化响应
      const responseText = response.text || '无响应内容'
      const fullMarkdown = `${infoSection}\n---\n🦀 **蟹老板说**\n\n${responseText}`

      // 转换为 entities 并分片发送
      const result = markdownToEntities(fullMarkdown)
      const chunks = splitEntities(result.text, result.entities, 4096)

      // 发送消息（第一个块更新处理中消息）
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const isFirstChunk = i === 0

        if (isFirstChunk && this.adapter.editMessage) {
          // 编辑现有消息
          await this.adapter.editMessage(processingMsg.messageId, {
            chatId,
            text: chunk.text,
            parseMode: 'entities',
            entities: chunk.entities,
          })
        } else {
          // 发送新消息
          await this.sendMessage({
            chatId,
            text: chunk.text,
            parseMode: 'entities',
            entities: chunk.entities,
          })
        }
      }
    } catch (err) {
      // 从 pending 中移除
      this.pendingMessages.delete(processingMsg.messageId)

      const errorMsg = err instanceof Error ? err.message : String(err)
      const errorText = `${infoSection}\n---\n🦀 **蟹老板说**\n\n**请求失败**\n\n${errorMsg}`
      const errorResult = markdownToEntities(errorText)

      if (this.adapter.editMessage) {
        await this.adapter.editMessage(processingMsg.messageId, {
          chatId,
          text: errorResult.text,
          parseMode: 'entities',
          entities: errorResult.entities
        })
      }
    }
  }

  // 获取 session 标题
  private async getSessionTitle(instanceId: string, sessionId: string): Promise<string> {
    try {
      const response = await this.registry.sendToInstance(instanceId, {
        type: 'command',
        command: 'get_session_title',
        sessionId
      })
      return response.title || '未命名'
    } catch {
      return '未知会话'
    }
  }

  // 处理问题回复
  private async handleQuestionReply(userId: string, requestId: string, value: string): Promise<void> {
    const instance = this.registry.getUserInstance(userId)

    if (!instance) {
      console.error('No instance selected for user:', userId)
      return
    }

    try {
      await this.registry.sendToInstance(instance.id, {
        type: 'question_reply',
        requestId,
        value
      })
    } catch (err) {
      console.error('Error sending question reply:', err)
    }
  }

  // 处理权限回复
  private async handlePermissionReply(userId: string, requestId: string, value: 'once' | 'always' | 'reject'): Promise<void> {
    const instance = this.registry.getUserInstance(userId)

    if (!instance) {
      console.error('No instance selected for user:', userId)
      return
    }

    try {
      await this.registry.sendToInstance(instance.id, {
        type: 'permission_reply',
        requestId,
        value
      })
    } catch (err) {
      console.error('Error sending permission reply:', err)
    }
  }

  // 处理选择组合
  private async handleSelectCombo(
    userId: string,
    shortId: string,
    callbackId: string,
    chatId: number,
    messageId?: string
  ): Promise<void> {
    // 从上下文中获取映射表
    const goContext = this.goMessageContexts.get(userId)

    if (!goContext || !goContext.comboMap) {
      if ('answerCallbackQuery' in this.adapter) {
        await (this.adapter as any).answerCallbackQuery(callbackId, '会话已过期，请重新输入 /go')
      }
      return
    }

    // 通过短ID查找组合
    const combo = goContext.comboMap.get(shortId)

    if (!combo) {
      if ('answerCallbackQuery' in this.adapter) {
        await (this.adapter as any).answerCallbackQuery(callbackId, '选择已失效')
      }
      return
    }

    const instanceId = combo.instanceId
    const sessionId = combo.sessionId

    // 检查实例是否仍然在线
    const instance = this.registry.getInstance(instanceId)
    if (!instance) {
      if ('answerCallbackQuery' in this.adapter) {
        await (this.adapter as any).answerCallbackQuery(callbackId, '实例已断开')
      }

      // 原地更新消息，显示错误
      if (messageId && this.adapter.editMessage) {
        await this.adapter.editMessage(messageId, {
          chatId,
          text: '🚀 **快速切换**\n\n❌ 该实例已断开连接，请重新选择。',
          parseMode: 'entities'
        })
      }
      return
    }

    // 更新用户选择
    this.registry.setUserInstance(userId, instanceId)
    this.registry.setUserSession(userId, sessionId)

    // 获取会话标题
    const sessionTitle = await this.getSessionTitle(instanceId, sessionId)

    // 更新最近组合记录（刷新时间和计数）
    this.recordRecentCombo(userId, instanceId, combo.instanceName, sessionId, sessionTitle)

    if ('answerCallbackQuery' in this.adapter) {
      await (this.adapter as any).answerCallbackQuery(callbackId, '切换成功')
    }

    // 构建选中状态的消息
    const selectedText = `🚀 **快速切换**\n\n✅ **已选择**\n\ninstance: ${instanceId}\nTitle: ${sessionTitle}\nSession Id: \`${sessionId}\``

    // 原地更新消息
    if (messageId && this.adapter.editMessage) {
      await this.adapter.editMessage(messageId, {
        chatId,
        text: selectedText,
        parseMode: 'entities'
      })
    } else {
      // 如果无法编辑，发送新消息
      await this.sendMessage({
        chatId,
        text: selectedText,
        parseMode: 'entities'
      })
    }
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
          await this.sendMessage({
            chatId: chatId,
            text: `**命令执行失败**\n\n操作: ${command}\n错误: ${response.error}`,
            parseMode: 'entities'
          })
        } else {
          await (this.adapter as any).answerCallbackQuery(callbackId, `执行成功`)

          // 特殊处理 session_new - 自动切换到新 session
          if (command === 'session_new' && response.sessionId) {
            this.registry.setUserSession(userId, response.sessionId)
            sessionId = response.sessionId
          }

          // 构建结果消息
          const sessionTitle = sessionId ? await this.getSessionTitle(instance.id, sessionId) : '未命名'
          let resultText = `**OpenCode 远程控制面板**\n---\n\n`
          resultText += `instance: ${instance.id}\n`
          if (sessionId) {
            resultText += `${sessionTitle}:\`${sessionId}\`\n`
          }
          resultText += `\n**命令执行成功**\n\n操作: ${command}`

          if (command === 'session_new' && response.sessionId) {
            resultText += `\n\n已自动切换到新 session。`
          } else if (command === 'autotitle' && response.title) {
            resultText += `\n\n新标题: **${response.title}**`
          }

          // 如果有 messageId，编辑原消息移除按钮；否则发送新消息
          if (messageId && this.adapter.editMessage) {
            await this.adapter.editMessage(messageId, {
              chatId,
              text: resultText,
              parseMode: 'entities'
            })
          } else {
            await this.sendMessage({
              chatId: chatId,
              text: resultText,
              parseMode: 'entities'
            })
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      if ('answerCallbackQuery' in this.adapter) {
        await (this.adapter as any).answerCallbackQuery(callbackId, '执行失败')
      }
      await this.sendMessage({
        chatId: chatId,
        text: `**命令执行失败**\n\n操作: ${command}\n错误: ${errorMsg}`,
        parseMode: 'entities'
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

    // 构建消息文本
    let text = `instance: ${instanceId}\nTitle: ${sessionTitle}\nSession Id: \`${sessionId}\`\n\n`
    text += `🦀 **蟹老板需要您的确认**\n\n`
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
      const result = await this.sendMessage({
        chatId,
        text,
        parseMode: 'entities',
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

    // 构建消息文本
    let text = `instance: ${instanceId}\nTitle: ${sessionTitle}\nSession Id: \`${sessionId}\`\n\n`
    text += `🦀 **蟹老板请求权限**\n\n`
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
      const result = await this.sendMessage({
        chatId,
        text,
        parseMode: 'entities',
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
}
