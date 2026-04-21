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
   * 获取或创建 Instance 对应的 Thread。
   *
   * 查找顺序：
   *   1. 内存映射（同进程会话内复用，含活跃/归档两种情况）
   *   2. Guild 活跃线程 API（/guilds/{id}/threads/active）
   *   3. Channel 归档线程 API（/channels/{id}/threads/archived/public）
   *   4. 以上均无匹配 → 创建新 thread
   *
   * 找到已有 thread 时，根据 connectReason 发送对应通知消息：
   *   - 'connect'   → 发送 "Instance Connected" 消息（hub 启动/重启后 instance 连接）
   *   - 'reconnect' → 发送 "Instance Reconnected" 消息（instance 掉线后重新上线）
   *   - undefined   → 不发送状态消息（静默获取，用于普通消息发送）
   */
  async getOrCreateThread(
    instanceId: string,
    instanceName: string,
    connectReason?: 'connect' | 'reconnect'
  ): Promise<string> {
    const threadName = instanceName.split('/').pop() || instanceId

    // ── 1. 内存映射命中 ──────────────────────────────────────────────────────
    const existing = this.instanceThreads.get(instanceId)
    if (existing) {
      console.log(`[Discord] Found in-memory mapping for ${instanceId}: thread ${existing.threadId}`)
      const thread = await this.getThread(existing.threadId)
      if (thread) {
        if (thread.thread_metadata?.archived) {
          console.log(`[Discord] In-memory thread ${existing.threadId} is archived, unarchiving...`)
          await this.unarchiveThread(existing.threadId)
        }
        existing.lastActivity = Date.now()
        if (connectReason) {
          await this.sendStatusMessage(existing.threadId, instanceId, instanceName, connectReason)
        }
        return existing.threadId
      }
      // Thread 不可访问，清除旧映射，继续向下查找
      console.log(`[Discord] In-memory thread ${existing.threadId} no longer accessible, searching...`)
      this.chatIdToThread.delete(existing.numberChatId)
      this.instanceThreads.delete(instanceId)
    }

    // ── 2. Guild 活跃线程 ────────────────────────────────────────────────────
    if (this.guildId) {
      const activeThread = await this.findActiveThreadByName(threadName)
      if (activeThread) {
        console.log(`[Discord] Found active thread by name "${threadName}": ${activeThread}`)
        const threadId = await this.registerExistingThread(instanceId, activeThread)
        if (connectReason) {
          await this.sendStatusMessage(threadId, instanceId, instanceName, connectReason)
        }
        return threadId
      }

      // ── 3. Channel 归档线程 ────────────────────────────────────────────────
      const archivedThread = await this.findArchivedThreadByName(threadName)
      if (archivedThread) {
        console.log(`[Discord] Found archived thread by name "${threadName}": ${archivedThread}, unarchiving...`)
        await this.unarchiveThread(archivedThread)
        const threadId = await this.registerExistingThread(instanceId, archivedThread)
        if (connectReason) {
          await this.sendStatusMessage(threadId, instanceId, instanceName, connectReason)
        }
        return threadId
      }
    }

    // ── 4. 创建新 thread ────────────────────────────────────────────────────
    console.log(`[Discord] No existing thread found for "${threadName}", creating new one`)
    const newThreadId = await this.createThread(instanceId, instanceName)
    // 向新 thread 内发送 connected 消息（createThread 只在 channel 发了锚点）
    if (connectReason) {
      await this.sendStatusMessage(newThreadId, instanceId, instanceName, connectReason)
    } else {
      // 无论如何，新建 thread 时总要发 connected 消息
      await this.sendStatusMessage(newThreadId, instanceId, instanceName, 'connect')
    }
    return newThreadId
  }

  /**
   * 在活跃线程列表（/guilds/{guildId}/threads/active）中按名称查找
   */
  private async findActiveThreadByName(threadName: string): Promise<string | undefined> {
    try {
      console.log(`[Discord] Searching active threads in guild ${this.guildId} for "${threadName}"...`)
      const response = await this.fetchWithAuth<{ threads: DiscordThread[] }>(
        `/guilds/${this.guildId}/threads/active`
      )
      for (const thread of response.threads || []) {
        if (thread.parent_id === this.channelId && thread.name === threadName) {
          // 验证可访问性
          if (await this.verifyThreadAccess(thread.id)) {
            return thread.id
          }
        }
      }
    } catch (error) {
      console.error(`[Discord] Failed to query active threads:`, error)
    }
    return undefined
  }

  /**
   * 在归档线程列表（/channels/{channelId}/threads/archived/public）中按名称查找
   * 支持分页，最多查询前 100 条
   */
  private async findArchivedThreadByName(threadName: string): Promise<string | undefined> {
    try {
      console.log(`[Discord] Searching archived threads in channel ${this.channelId} for "${threadName}"...`)
      const response = await this.fetchWithAuth<{ threads: DiscordThread[]; has_more: boolean }>(
        `/channels/${this.channelId}/threads/archived/public?limit=100`
      )
      for (const thread of response.threads || []) {
        if (thread.name === threadName) {
          console.log(`[Discord] Found archived thread: ${thread.id} (name: "${thread.name}")`)
          return thread.id
        }
      }
    } catch (error) {
      console.error(`[Discord] Failed to query archived threads:`, error)
    }
    return undefined
  }

  /**
   * 将已有 threadId 注册为 instanceId 的内存映射，并加入 thread。
   * 同时拉取当前最新消息 ID 作为 lastMessageId 的初始值，
   * 防止 hub 重启后重新处理历史消息。
   */
  private async registerExistingThread(instanceId: string, threadId: string): Promise<string> {
    this.chatIdCounter++
    const numberChatId = this.chatIdCounter

    // 加入 thread（确保 bot 可以收发消息）
    try {
      await this.fetchWithAuth(`/channels/${threadId}/thread-members/@me`, { method: 'PUT' })
      console.log(`[Discord] Bot joined thread ${threadId}`)
    } catch (joinError) {
      console.warn(`[Discord] Failed to join thread ${threadId}:`, joinError)
    }

    // 拉取当前最新消息 ID，作为轮询起点，避免重放历史消息
    const lastMessageId = await this.fetchLatestMessageId(threadId)
    if (lastMessageId) {
      console.log(`[Discord] Initialized lastMessageId for thread ${threadId}: ${lastMessageId}`)
    }

    const mapping: ThreadMapping = {
      instanceId,
      threadId,
      channelId: this.channelId,
      lastActivity: Date.now(),
      numberChatId,
      lastMessageId
    }
    this.instanceThreads.set(instanceId, mapping)
    this.chatIdToThread.set(numberChatId, threadId)

    return threadId
  }

  /**
   * 获取指定 thread 中当前最新的消息 ID（limit=1）
   * 返回 undefined 表示 thread 为空或请求失败
   */
  private async fetchLatestMessageId(threadId: string): Promise<string | undefined> {
    try {
      const messages = await this.fetchWithAuth<DiscordMessage[]>(
        `/channels/${threadId}/messages?limit=1`
      )
      if (messages.length > 0) {
        return messages[0].id
      }
    } catch (error) {
      console.warn(`[Discord] Failed to fetch latest message for thread ${threadId}:`, error)
    }
    return undefined
  }

  /**
   * 取消归档 thread
   */
  private async unarchiveThread(threadId: string): Promise<void> {
    try {
      await this.fetchWithAuth(`/channels/${threadId}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: false })
      })
      console.log(`[Discord] ✓ Unarchived thread ${threadId}`)
    } catch (error) {
      console.warn(`[Discord] Failed to unarchive thread ${threadId}:`, error)
    }
  }

  /**
   * 验证 bot 是否能访问（加入并读取消息）指定 thread
   */
  private async verifyThreadAccess(threadId: string): Promise<boolean> {
    try {
      await this.fetchWithAuth(`/channels/${threadId}/thread-members/@me`, { method: 'PUT' })
      await this.fetchWithAuth(`/channels/${threadId}/messages?limit=1`)
      return true
    } catch {
      return false
    }
  }

  /**
   * 向 thread 发送状态消息（connected / reconnected）
   */
  private async sendStatusMessage(
    threadId: string,
    instanceId: string,
    instanceName: string,
    reason: 'connect' | 'reconnect'
  ): Promise<void> {
    const isConnect = reason === 'connect'
    const label = isConnect ? 'Instance Connected' : 'Instance Reconnected'
    const embed: DiscordEmbed = {
      title: isConnect ? '🟢 Instance Connected' : '🔄 Instance Reconnected',
      color: isConnect ? 0x57F287 : 0xFEE75C, // 绿 / 黄
      fields: [
        { name: 'Workspace', value: `\`${instanceName}\``, inline: false },
        { name: 'Instance ID', value: `\`${instanceId}\``, inline: false }
      ],
      timestamp: new Date().toISOString()
    }

    try {
      await this.fetchWithAuth<{ id: string }>(`/channels/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ embeds: [embed] })
      })
      console.log(`[Discord] ✓ Sent "${label}" message to thread ${threadId}`)
    } catch (error) {
      console.error(`[Discord] ✗ Failed to send status message to thread ${threadId}:`, error)
    }
  }

  /**
   * 创建 Thread
   * starter message 只作为 thread 锚点，connected 消息由 getOrCreateThread 通过 sendStatusMessage 发送
   */
  private async createThread(instanceId: string, instanceName: string): Promise<string> {
    console.log(`[Discord] Creating thread for ${instanceId} in channel ${this.channelId}`)
    const threadName = instanceName.split('/').pop() || instanceId

    // 先发送一条消息作为 thread 的 starter（channel 内可见的锚点）
    console.log(`[Discord] Step 1: Sending starter message...`)
    const starterMessage = await this.sendChannelMessage({
      content: `📌 **OpenCode Instance Thread**\n📁 \`${instanceName}\`\n🆔 \`${instanceId}\``
    })
    console.log(`[Discord] Step 1 complete: Starter message sent (ID: ${starterMessage.id})`)

    // 基于消息创建 thread
    console.log(`[Discord] Step 2: Creating thread from message ${starterMessage.id}...`)
    const thread = await this.fetchWithAuth<DiscordThread>(
      `/channels/${this.channelId}/messages/${starterMessage.id}/threads`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: threadName,
          auto_archive_duration: 10080, // 7天
          // Note: type is ignored for message-based threads; Discord infers PUBLIC_THREAD automatically
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
  async sendDisconnectNotification(instanceId: string, instanceName?: string): Promise<void> {
    const mapping = this.instanceThreads.get(instanceId)
    if (!mapping) {
      console.warn(`[Discord] No thread mapping for ${instanceId}, skipping disconnect notification`)
      return
    }

    const fields: DiscordEmbed['fields'] = [
      { name: 'Instance ID', value: `\`${instanceId}\``, inline: false }
    ]
    if (instanceName) {
      fields.unshift({ name: 'Workspace', value: `\`${instanceName}\``, inline: false })
    }
    const embed: DiscordEmbed = {
      title: '🔴 Instance Disconnected',
      color: 0xED4245, // 红
      fields,
      footer: { text: 'Thread will auto-archive after 7 days of inactivity' },
      timestamp: new Date().toISOString()
    }

    try {
      await this.fetchWithAuth(`/channels/${mapping.threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ embeds: [embed] })
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
   * 使用 Embed 发送，解决连续消息聚合难以区分的问题。
   * Discord Embed description 上限 4096 字符，超出时拆分为多个 embed。
   */
  async sendMessage(message: IMOutgoingMessage): Promise<{ messageId: string }> {
    const threadId = this.chatIdToThread.get(message.chatId)
    if (!threadId) {
      throw new Error(`Unknown chatId: ${message.chatId}. Thread may not exist.`)
    }
    console.log(`[Discord] Sending message to thread ${threadId} (chatId: ${message.chatId}, length: ${message.text.length})`)

    // Embed description 上限 4096，留 96 字符余量
    const MAX_EMBED_LENGTH = 4000
    const chunks = this.splitMessage(message.text, MAX_EMBED_LENGTH)
    let lastMessageId = ''

    for (let i = 0; i < chunks.length; i++) {
      const isLastChunk = i === chunks.length - 1
      const isMultiChunk = chunks.length > 1

      const embed: DiscordEmbed = {
        description: chunks[i],
        color: 0x5865F2, // Discord 品牌紫，AI 响应专用色
        timestamp: isLastChunk ? new Date().toISOString() : undefined,
        footer: isMultiChunk ? { text: `Part ${i + 1} / ${chunks.length}` } : undefined
      }

      const payload: {
        embeds: DiscordEmbed[]
        components?: DiscordComponent[]
      } = { embeds: [embed] }

      // 只在最后一条消息添加按钮
      if (isLastChunk && message.replyMarkup) {
        payload.components = this.convertKeyboardToComponents(message.replyMarkup)
      }

      const response = await this.fetchWithAuth<{ id: string }>(
        `/channels/${threadId}/messages`,
        { method: 'POST', body: JSON.stringify(payload) }
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
   * 编辑消息（同步更新 embed description）
   */
  async editMessage(messageId: string, message: Partial<IMOutgoingMessage>): Promise<void> {
    if (!message.chatId) return

    const threadId = this.chatIdToThread.get(message.chatId)
    if (!threadId) {
      console.error(`[Discord] Cannot edit message: unknown chatId ${message.chatId}`)
      return
    }

    const payload: {
      embeds?: DiscordEmbed[]
      components?: DiscordComponent[]
    } = {}

    if (message.text) {
      payload.embeds = [{
        description: message.text,
        color: 0x5865F2,
        timestamp: new Date().toISOString()
      }]
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
