import type { 
  IMAdapter, 
  IMMessage, 
  IMCallbackQuery, 
  IMOutgoingMessage,
  IMUser,
  IMKeyboard
} from '../types/index.js'

// Discord 类型定义
interface DiscordThread {
  id: string
  name: string
  parent_id: string
  type: number
  thread_metadata?: {
    archived: boolean
    auto_archive_duration: number
    archive_timestamp: string
    locked: boolean
  }
}

interface DiscordMessage {
  id: string
  channel_id: string
  author: {
    id: string
    username: string
    bot?: boolean
  }
  content: string
  timestamp: string
  components?: DiscordComponent[]
  embeds?: DiscordEmbed[]
}

interface DiscordInteraction {
  id: string
  type: number
  token: string  // 用于响应交互
  data?: {
    custom_id: string
    component_type: number
  }
  member?: {
    user: {
      id: string
      username: string
    }
  }
  message?: {
    id: string
    channel_id: string
  }
}

interface DiscordComponent {
  type: number
  components?: DiscordComponent[]
  custom_id?: string
  label?: string
  style?: number
  url?: string
  emoji?: {
    name: string
  }
}

interface DiscordEmbed {
  title?: string
  description?: string
  color?: number
  fields?: Array<{
    name: string
    value: string
    inline?: boolean
  }>
  timestamp?: string
  footer?: {
    text: string
  }
}

// Thread 映射关系
interface ThreadMapping {
  instanceId: string
  threadId: string
  channelId: string
  lastActivity: number
  starterMessageId?: string
  lastMessageId?: string  // 每个 Thread 独立跟踪最后一条消息
  numberChatId: number     // 用于映射回字符串 threadId
}

export class DiscordAdapter implements IMAdapter {
  readonly name = 'discord'
  readonly version = '1.0.0'

  private botToken: string
  private channelId: string
  private guildId: string = ''
  private baseUrl = 'https://discord.com/api/v10'
  private running: boolean = false
  private messageHandlers: Array<(message: IMMessage) => void> = []
  private callbackHandlers: Array<(callback: IMCallbackQuery) => void> = []
  private instanceThreads: Map<string, ThreadMapping> = new Map()
  private chatIdToThread: Map<number, string> = new Map() // number chatId -> threadId string
  private pollInterval: NodeJS.Timeout | null = null
  private lastMessageId: string | null = null
  private chatIdCounter: number = 1000 // 递增计数器，保证 chatId 唯一

  constructor() {
    this.botToken = ''
    this.channelId = ''
  }

  /**
   * 初始化 Adapter
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    this.botToken = config.botToken as string
    this.channelId = config.channelId as string
    
    if (!this.botToken || !this.channelId) {
      throw new Error('Discord adapter requires botToken and channelId')
    }

    // 获取 guildId
    await this.fetchGuildId()
  }

  /**
   * 通过 channelId 获取 guildId
   */
  private async fetchGuildId(): Promise<void> {
    try {
      const channel = await this.fetchWithAuth<{ guild_id: string }>(`/channels/${this.channelId}`)
      this.guildId = channel.guild_id
      console.log(`[Discord] Fetched guildId: ${this.guildId} from channel ${this.channelId}`)
    } catch (error) {
      console.warn(`[Discord] Failed to fetch guildId:`, error)
    }
  }

  /**
   * 获取或创建 Instance 对应的 Thread
   * 通过 Guild API 查询活跃线程，按名称匹配
   */
  async getOrCreateThread(instanceId: string, instanceName: string): Promise<string> {
    const threadName = instanceName.split('/').pop() || instanceId

    // 1. 检查内存中是否已有映射（同一会话内复用）
    const existing = this.instanceThreads.get(instanceId)
    if (existing) {
      console.log(`[Discord] Found existing mapping for ${instanceId}: thread ${existing.threadId}`)
      
      // 尝试访问 thread
      const thread = await this.getThread(existing.threadId)
      if (thread && !thread.thread_metadata?.archived) {
        // Thread 活跃，直接复用
        existing.lastActivity = Date.now()
        console.log(`[Discord] Reusing active thread for ${instanceId}: ${existing.threadId}`)
        return existing.threadId
      }
    }

    // 2. 通过 Guild API 查询活跃线程
    if (this.guildId) {
      const existingThreadId = await this.findThreadByName(threadName)
      if (existingThreadId) {
        console.log(`[Discord] Found existing thread by name "${threadName}": ${existingThreadId}`)
        
        // 创建映射
        this.chatIdCounter++
        const numberChatId = this.chatIdCounter
        const mapping: ThreadMapping = {
          instanceId,
          threadId: existingThreadId,
          channelId: this.channelId,
          lastActivity: Date.now(),
          numberChatId
        }
        this.instanceThreads.set(instanceId, mapping)
        this.chatIdToThread.set(numberChatId, existingThreadId)
        
        // 重新加入 thread
        try {
          await this.fetchWithAuth(`/channels/${existingThreadId}/thread-members/@me`, {
            method: 'PUT'
          })
          console.log(`[Discord] Re-joined thread ${existingThreadId}`)
        } catch (joinError) {
          console.warn(`[Discord] Failed to join thread:`, joinError)
        }
        
        // 发送重新连接通知
        try {
          await this.fetchWithAuth(`/channels/${existingThreadId}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              content: `🟢 **Instance Reconnected**\n⏰ ${new Date().toLocaleString()}`
            })
          })
        } catch (msgError) {
          console.warn(`[Discord] Failed to send reconnection message:`, msgError)
        }
        
        return existingThreadId
      }
    }

    // 3. 创建新的 thread
    console.log(`[Discord] No existing thread found for "${threadName}", creating new one`)
    return this.createThread(instanceId, instanceName)
  }

  /**
   * 通过 Guild API 按名称查找 Thread
   */
  private async findThreadByName(threadName: string): Promise<string | undefined> {
    if (!this.guildId) {
      console.warn(`[Discord] No guildId available, cannot query threads`)
      return undefined
    }

    try {
      console.log(`[Discord] Querying active threads from guild ${this.guildId}...`)
      
      // 获取所有活跃线程
      const response = await this.fetchWithAuth<{
        threads: DiscordThread[]
        members: any[]
      }>(`/guilds/${this.guildId}/threads/active`)
      
      console.log(`[Discord] Found ${response.threads?.length || 0} active threads in guild`)
      
      // 查找匹配的 thread
      for (const thread of response.threads || []) {
        // 只找属于当前频道的 thread
        if (thread.parent_id === this.channelId && thread.name === threadName) {
          console.log(`[Discord] ✓ Found matching thread: ${thread.id} (name: "${thread.name}")`)
          return thread.id
        }
      }
      
      console.log(`[Discord] ✗ No thread found with name "${threadName}" in channel ${this.channelId}`)
    } catch (error) {
      console.error(`[Discord] Failed to query guild threads:`, error)
    }
    
    return undefined
  }

  /**
   * 创建 Thread
   */
  private async createThread(instanceId: string, instanceName: string): Promise<string> {
    console.log(`[Discord] Creating thread for ${instanceId} in channel ${this.channelId}`)
    
    // 先发送一条消息作为 thread 的 starter
    console.log(`[Discord] Step 1: Sending starter message...`)
    const starterMessage = await this.sendChannelMessage({
      content: `🤖 **Instance Connected**\n📁 **Workspace**: \`${instanceName}\`\n⏰ **Time**: ${new Date().toLocaleString()}`,
      embeds: [{
        title: '🚀 OpenCode Instance',
        description: `**ID**: \`${instanceId}\`\n**Status**: 🟢 Active`,
        color: 0x00ff00,
        timestamp: new Date().toISOString()
      }]
    })
    console.log(`[Discord] Step 1 complete: Starter message sent (ID: ${starterMessage.id})`)

    // 基于消息创建 thread
    console.log(`[Discord] Step 2: Creating thread from message ${starterMessage.id}...`)
    const thread = await this.fetchWithAuth<DiscordThread>(
      `/channels/${this.channelId}/messages/${starterMessage.id}/threads`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: instanceName.split('/').pop() || instanceId,
          auto_archive_duration: 10080, // 7天
          type: 11 // PUBLIC_THREAD
        })
      }
    )
    console.log(`[Discord] Step 2 complete: Thread created (ID: ${thread.id})`)

    // Step 3: 让 Bot 加入 Thread（必需，否则无法收发消息）
    console.log(`[Discord] Step 3: Joining thread...`)
    try {
      await this.fetchWithAuth(`/channels/${thread.id}/thread-members/@me`, {
        method: 'PUT'
      })
      console.log(`[Discord] Step 3 complete: Bot joined thread`)
    } catch (joinError) {
      console.warn(`[Discord] Warning: Failed to join thread, but continuing:`, joinError)
    }

    // 生成唯一的 number chatId（使用递增计数器避免冲突）
    this.chatIdCounter++
    const numberChatId = this.chatIdCounter
    console.log(`[Discord] Thread ID: ${thread.id} -> Chat ID: ${numberChatId} (instance: ${instanceId})`)

    // 保存映射关系
    const mapping: ThreadMapping = {
      instanceId,
      threadId: thread.id,
      channelId: this.channelId,
      lastActivity: Date.now(),
      starterMessageId: starterMessage.id,
      numberChatId
    }
    this.instanceThreads.set(instanceId, mapping)
    this.chatIdToThread.set(numberChatId, thread.id)

    console.log(`[Discord] Created thread for instance ${instanceId}: ${thread.id} (chatId: ${numberChatId})`)
    return thread.id
  }

  /**
   * 获取 Thread 信息
   */
  private async getThread(threadId: string): Promise<DiscordThread | null> {
    try {
      return await this.fetchWithAuth<DiscordThread>(`/channels/${threadId}`)
    } catch (error) {
      return null
    }
  }

  /**
   * 发送断开连接通知（不归档，依赖 Discord 7 天自动归档）
   */
  async sendDisconnectNotification(instanceId: string): Promise<void> {
    const mapping = this.instanceThreads.get(instanceId)
    if (!mapping) return

    try {
      await this.fetchWithAuth(`/channels/${mapping.threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: `🔴 **Instance Disconnected**\n⏰ ${new Date().toLocaleString()}\n\n_Thread will auto-archive after 7 days of inactivity_`
        })
      })
      console.log(`[Discord] Sent disconnect notification for instance ${instanceId}`)
    } catch (error) {
      console.warn(`[Discord] Failed to send disconnect notification:`, error)
    }
  }

  /**
   * 发送消息到 Channel（用于创建 thread starter）
   */
  private async sendChannelMessage(payload: {
    content: string
    embeds?: DiscordEmbed[]
    components?: DiscordComponent[]
  }): Promise<{ id: string }> {
    return this.fetchWithAuth<{ id: string }>(`/channels/${this.channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload)
    })
  }

  /**
   * 发送消息（IMAdapter 接口实现）
   * Discord 限制: 内容最多 2000 字符
   */
  async sendMessage(message: IMOutgoingMessage): Promise<{ messageId: string }> {
    // 通过 chatId 查找真正的 threadId
    const threadId = this.chatIdToThread.get(message.chatId)
    if (!threadId) {
      throw new Error(`Unknown chatId: ${message.chatId}. Thread may not exist.`)
    }
    console.log(`[Discord] Sending message to thread ${threadId} (chatId: ${message.chatId}, length: ${message.text.length})`)

    // Discord 内容限制 2000 字符，留 50 字符余量
    const MAX_LENGTH = 1950
    let lastMessageId = ''

    // 分割长消息
    const chunks = this.splitMessage(message.text, MAX_LENGTH)
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const isLastChunk = i === chunks.length - 1

      const payload: {
        content: string
        embeds?: DiscordEmbed[]
        components?: DiscordComponent[]
      } = {
        content: chunk
      }

      // 只在最后一条消息添加按钮
      if (isLastChunk && message.replyMarkup) {
        payload.components = this.convertKeyboardToComponents(message.replyMarkup)
      }

      const response = await this.fetchWithAuth<{ id: string }>(
        `/channels/${threadId}/messages`,
        {
          method: 'POST',
          body: JSON.stringify(payload)
        }
      )

      lastMessageId = response.id
    }

    return { messageId: lastMessageId }
  }

  /**
   * 分割长消息（按行分割，尽量保持完整性）
   */
  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text]
    }

    const chunks: string[] = []
    const lines = text.split('\n')
    let currentChunk = ''

    for (const line of lines) {
      // 如果单行就超过限制，强制分割
      if (line.length > maxLength) {
        if (currentChunk) {
          chunks.push(currentChunk)
          currentChunk = ''
        }
        
        // 按字符分割长行
        for (let i = 0; i < line.length; i += maxLength) {
          chunks.push(line.slice(i, i + maxLength))
        }
        continue
      }

      // 检查添加此行后是否超过限制
      const newChunk = currentChunk ? currentChunk + '\n' + line : line
      if (newChunk.length > maxLength) {
        chunks.push(currentChunk)
        currentChunk = line
      } else {
        currentChunk = newChunk
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk)
    }

    return chunks
  }

  /**
   * 编辑消息
   */
  async editMessage(messageId: string, message: Partial<IMOutgoingMessage>): Promise<void> {
    if (!message.chatId) return
    
    // 通过 chatId 查找真正的 threadId
    const threadId = this.chatIdToThread.get(message.chatId)
    if (!threadId) {
      console.error(`[Discord] Cannot edit message: unknown chatId ${message.chatId}`)
      return
    }

    const payload: {
      content?: string
      components?: DiscordComponent[]
    } = {}

    if (message.text) {
      payload.content = message.text
    }

    if (message.replyMarkup) {
      payload.components = this.convertKeyboardToComponents(message.replyMarkup)
    }

    await this.fetchWithAuth(`/channels/${threadId}/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    })
  }

  /**
   * 转换 IMKeyboard 为 Discord Components
   */
  private convertKeyboardToComponents(keyboard: IMKeyboard): DiscordComponent[] {
    const components: DiscordComponent[] = []

    for (const row of keyboard.inline) {
      const actionRow: DiscordComponent = {
        type: 1, // ACTION_ROW
        components: []
      }

      for (const button of row) {
        const discordButton: DiscordComponent = {
          type: 2, // BUTTON
          label: button.text,
          style: button.url ? 5 : 1, // 5 = LINK, 1 = PRIMARY
          custom_id: button.callbackData,
          url: button.url
        }
        actionRow.components!.push(discordButton)
      }

      components.push(actionRow)
    }

    return components
  }

  /**
   * 发送富文本消息（带 Embed）
   */
  async sendEmbedMessage(
    threadId: string,
    content: string,
    embed: DiscordEmbed,
    components?: IMKeyboard
  ): Promise<{ messageId: string }> {
    const payload: {
      content: string
      embeds: DiscordEmbed[]
      components?: DiscordComponent[]
    } = {
      content,
      embeds: [embed]
    }

    if (components) {
      payload.components = this.convertKeyboardToComponents(components)
    }

    const response = await this.fetchWithAuth<{ id: string }>(
      `/channels/${threadId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(payload)
      }
    )

    return { messageId: response.id }
  }

  /**
   * 发送实例消息（用于 Bridge Hub）
   */
  async sendInstanceMessage(
    instanceId: string,
    instanceName: string,
    content: string,
    sessionInfo?: {
      sessionId: string
      sessionTitle: string
    },
    buttons?: IMKeyboard
  ): Promise<{ messageId: string; threadId: string; chatId: number }> {
    const threadId = await this.getOrCreateThread(instanceId, instanceName)

    const embed: DiscordEmbed = {
      description: content,
      color: 0x0099ff,
      timestamp: new Date().toISOString()
    }

    if (sessionInfo) {
      embed.fields = [
        {
          name: 'Session',
          value: `\`${sessionInfo.sessionId}\``,
          inline: true
        },
        {
          name: 'Title',
          value: sessionInfo.sessionTitle,
          inline: true
        }
      ]
    }

    const result = await this.sendEmbedMessage(
      threadId,
      '🦀 **蟹老板说：**',
      embed,
      buttons
    )

    // 获取对应的 numberChatId
    const mapping = this.instanceThreads.get(instanceId)
    const chatId = mapping?.numberChatId || 0

    return { messageId: result.messageId, threadId, chatId }
  }

  /**
   * 通用 fetch 方法
   */
  private async fetchWithAuth<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bot ${this.botToken}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    })

    if (!response.ok) {
      const error = await response.text()
      try {
        const errorData = JSON.parse(error)
        console.error(`[Discord] API Error:`, {
          endpoint,
          status: response.status,
          code: errorData.code,
          message: errorData.message
        })
      } catch {
        console.error(`[Discord] API Error:`, {
          endpoint,
          status: response.status,
          error
        })
      }
      throw new Error(`Discord API error: ${error}`)
    }

    // 处理空响应（204 No Content 等）
    const contentType = response.headers.get('content-type')
    if (!contentType || !contentType.includes('application/json')) {
      return {} as T
    }

    const data = await response.json()
    return data as T
  }

  /**
   * 注册消息处理器
   */
  onMessage(handler: (message: IMMessage) => void): void {
    this.messageHandlers.push(handler)
  }

  /**
   * 注册回调处理器
   */
  onCallback(handler: (callback: IMCallbackQuery) => void): void {
    this.callbackHandlers.push(handler)
  }

  /**
   * 启动 Adapter（轮询模式）
   */
  async start(): Promise<void> {
    if (this.running) return
    
    this.running = true
    console.log('[Discord] Adapter started')

    // 启动轮询
    this.pollInterval = setInterval(() => {
      this.pollMessages()
    }, 1000) // 每秒轮询一次
  }

  /**
   * 停止 Adapter
   */
  async stop(): Promise<void> {
    this.running = false
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    console.log('[Discord] Adapter stopped')
  }

  /**
   * 轮询消息（简化为只监听 Thread 中的消息）
   * 注意：实际生产环境应该使用 Gateway WebSocket
   */
  private async pollMessages(): Promise<void> {
    // 轮询所有活跃的 threads
    for (const [instanceId, mapping] of this.instanceThreads) {
      try {
        const messages = await this.fetchWithAuth<DiscordMessage[]>(
          `/channels/${mapping.threadId}/messages?limit=10`
        )

        // 按时间排序（从旧到新）
        const sortedMessages = messages.sort((a, b) => 
          BigInt(a.id) > BigInt(b.id) ? 1 : -1
        )

        for (const msg of sortedMessages) {
          // 跳过 bot 自己的消息
          if (msg.author.bot) continue

          // 只处理新消息（每个 Thread 独立跟踪）
          if (mapping.lastMessageId && BigInt(msg.id) <= BigInt(mapping.lastMessageId)) {
            continue
          }

          // 更新该 Thread 的最后消息 ID
          mapping.lastMessageId = msg.id
          mapping.lastActivity = Date.now()

          // 转换为 IMMessage
          const imMessage: IMMessage = {
            id: msg.id,
            user: {
              id: msg.author.id,
              name: msg.author.username,
              username: msg.author.username
            },
            text: msg.content,
            chatId: mapping.numberChatId, // 使用预计算的 number chatId
            timestamp: new Date(msg.timestamp),
            raw: msg
          }

          console.log(`[Discord] Message from thread ${mapping.threadId} (instance: ${instanceId}, chatId: ${mapping.numberChatId}): ${msg.content.substring(0, 50)}`)

          // 通知处理器
          for (const handler of this.messageHandlers) {
            try {
              handler(imMessage)
            } catch (err) {
              console.error(`[Discord] Error in message handler:`, err)
            }
          }
        }
      } catch (error) {
        // Thread 可能被归档或删除
        if (error instanceof Error && error.message.includes('Unknown Channel')) {
          console.warn(`[Discord] Thread ${mapping.threadId} not accessible, removing from tracking`)
          this.instanceThreads.delete(instanceId)
        }
      }
    }
  }

  /**
   * 处理交互（Button 点击等）
   * 注意：交互需要通过 Gateway 或 HTTP Interactions 接收
   */
  async handleInteraction(interaction: DiscordInteraction): Promise<void> {
    if (interaction.type !== 3) return // 不是组件交互

    console.log(`[Discord] Received interaction: ${interaction.id}, type: ${interaction.type}, custom_id: ${interaction.data?.custom_id}`)

    // 立即发送 ACK 响应（Discord 要求 3 秒内响应）- 不等待结果
    const ackPromise = this.fetchWithAuth(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: 'POST',
      body: JSON.stringify({
        type: 6 // ACK 响应，不显示加载状态
      })
    }).then(() => {
      console.log(`[Discord] Interaction ACK sent: ${interaction.id}`)
    }).catch((ackError) => {
      console.warn(`[Discord] Failed to ACK interaction:`, ackError)
    })

    // 不等待 ACK，立即处理回调
    // 通过 threadId 查找对应的 numberChatId
    const threadId = interaction.message?.channel_id
    let chatId = 0
    let foundInstanceId = ''
    for (const [instanceId, mapping] of this.instanceThreads) {
      if (mapping.threadId === threadId) {
        chatId = mapping.numberChatId
        foundInstanceId = instanceId
        break
      }
    }

    console.log(`[Discord] Interaction from thread ${threadId} -> chatId ${chatId}, instance: ${foundInstanceId || 'not found'}`)

    const callback: IMCallbackQuery = {
      id: interaction.id,
      user: {
        id: interaction.member?.user.id || 'unknown',
        name: interaction.member?.user.username || 'Unknown'
      },
      data: interaction.data?.custom_id || '',
      messageId: interaction.message?.id,
      chatId,
      raw: interaction
    }

    for (const handler of this.callbackHandlers) {
      try {
        handler(callback)
      } catch (err) {
        console.error(`[Discord] Error in callback handler:`, err)
      }
    }

    // 等待 ACK 完成（用于日志记录，但不阻塞回调处理）
    await ackPromise.catch(() => {})
  }

  /**
   * 获取 Instance 对应的 Thread ID
   */
  getThreadId(instanceId: string): string | undefined {
    return this.instanceThreads.get(instanceId)?.threadId
  }

  /**
   * 通过 chatId 查找 Instance ID（用于 Thread 自动路由）
   */
  getInstanceIdByChatId(chatId: number): string | undefined {
    console.log(`[Discord] Looking up instance for chatId ${chatId}, tracked threads: ${this.instanceThreads.size}`)
    for (const [instanceId, mapping] of this.instanceThreads) {
      console.log(`[Discord]   Checking: instance=${instanceId}, chatId=${mapping.numberChatId}, threadId=${mapping.threadId}`)
      if (mapping.numberChatId === chatId) {
        console.log(`[Discord]   Found match: ${instanceId}`)
        return instanceId
      }
    }
    console.log(`[Discord]   No match found for chatId ${chatId}`)
    return undefined
  }

  /**
   * 更新 Thread 标题
   */
  async updateThreadTitle(instanceId: string, title: string): Promise<void> {
    const mapping = this.instanceThreads.get(instanceId)
    if (!mapping) return

    // Discord 限制 thread 名称为 100 字符
    const truncatedTitle = title.slice(0, 100)

    try {
      await this.fetchWithAuth(`/channels/${mapping.threadId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: truncatedTitle })
      })
    } catch (error) {
      console.error(`[Discord] Failed to update thread title:`, error)
    }
  }
}
