import 'dotenv/config'
import { HubWebSocketServer } from './server/websocket-server.js'
import { TelegramAdapter } from './adapters/telegram.js'
import { DiscordAdapter } from './adapters/discord.js'
import { MessageRouter } from './router/message-router.js'
import type { IMAdapter } from './types/index.js'

// 配置类型定义
interface AdapterConfig {
  name: string
  enabled: boolean
  adapter: IMAdapter
  adminUsers: string[]
}

/**
 * 解析适配器列表（逗号分隔）
 */
function parseAdapters(envValue: string | undefined): string[] {
  if (!envValue) return []
  return envValue.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

/**
 * 解析用户 ID 列表（逗号分隔）
 */
function parseUserIds(envValue: string | undefined): string[] {
  if (!envValue) return []
  return envValue.split(',').map(s => s.trim()).filter(Boolean)
}

/**
 * 生成随机认证令牌
 */
function generateRandomToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let token = 'hub-'
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return token
}

async function main() {
  // -----------------------------------------------------------------------------
  // 基础配置
  // -----------------------------------------------------------------------------
  const port = parseInt(process.env.PORT || '38471')
  let authToken = process.env.AUTH_TOKEN

  // -----------------------------------------------------------------------------
  // 适配器配置（新的统一配置格式）
  // -----------------------------------------------------------------------------
  const enabledAdapters = parseAdapters(process.env.ADAPTERS)

  // 如果没有设置 ADAPTERS，则尝试兼容旧配置
  const hasExplicitTelegram = enabledAdapters.includes('telegram')
  const hasExplicitDiscord = enabledAdapters.includes('discord')

  // Telegram 配置
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN
  const telegramAdmins = parseUserIds(process.env.TELEGRAM_ADMIN_USERS)
  const telegramChats = parseUserIds(process.env.TELEGRAM_ALLOWED_CHATS)

  // Discord 配置
  const discordToken = process.env.DISCORD_BOT_TOKEN
  const discordChannelId = process.env.DISCORD_CHANNEL_ID
  const discordAdmins = parseUserIds(process.env.DISCORD_ADMIN_USERS)

  // 兼容旧配置：如果没有设置 ADAPTERS，根据具体配置推断
  const enableTelegram = hasExplicitTelegram || (!enabledAdapters.length && !!telegramToken)
  const enableDiscord = hasExplicitDiscord || (!enabledAdapters.length && !!discordToken && !!discordChannelId)

  // 检查至少有一个适配器可用
  if (!enableTelegram && !enableDiscord) {
    console.error('❌ Error: No adapters configured')
    console.error('')
    console.error('Please set at least one adapter:')
    console.error('  - Telegram: TELEGRAM_BOT_TOKEN')
    console.error('  - Discord: DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID')
    console.error('')
    console.error('Or set ADAPTERS environment variable:')
    console.error('  ADAPTERS=telegram,discord')
    process.exit(1)
  }

  // -----------------------------------------------------------------------------
  // 认证令牌
  // -----------------------------------------------------------------------------
  if (!authToken) {
    authToken = generateRandomToken()
    console.log('')
    console.log('⚠️  WARNING: AUTH_TOKEN not set, using auto-generated token:')
    console.log(`   ${authToken}`)
    console.log('')
    console.log('   Set this token in your plugin configuration.')
    console.log('   For production, please set AUTH_TOKEN environment variable.')
    console.log('')
  }

  // -----------------------------------------------------------------------------
  // 启动 Bridge Hub
  // -----------------------------------------------------------------------------
  console.log('🚀 Starting Bridge Hub...')
  console.log(`📡 WebSocket port: ${port}`)

  // 创建 WebSocket 服务器
  const wsServer = new HubWebSocketServer(port, authToken)
  const registry = wsServer.getRegistry()

  // -----------------------------------------------------------------------------
  // 初始化适配器
  // -----------------------------------------------------------------------------
  const adapters: AdapterConfig[] = []

  // Telegram
  if (enableTelegram && telegramToken) {
    console.log('📱 Initializing Telegram adapter...')
    const telegram = new TelegramAdapter(telegramToken)

    try {
      const botInfo = await telegram.getMe()
      console.log(`🤖 Telegram Bot: @${botInfo.username}`)

      adapters.push({
        name: 'telegram',
        enabled: true,
        adapter: telegram,
        adminUsers: telegramAdmins
      })
    } catch (err) {
      console.error('❌ Failed to validate Telegram bot token:', err)
      process.exit(1)
    }
  }

  // Discord
  if (enableDiscord && discordToken && discordChannelId) {
    console.log('📱 Initializing Discord adapter...')
    const discord = new DiscordAdapter()

    try {
      await discord.initialize({
        botToken: discordToken,
        channelId: discordChannelId
      })

      adapters.push({
        name: 'discord',
        enabled: true,
        adapter: discord,
        adminUsers: discordAdmins
      })
    } catch (err) {
      console.error('❌ Failed to initialize Discord adapter:', err)
      process.exit(1)
    }
  }

  if (adapters.length === 0) {
    console.error('❌ No adapters initialized successfully')
    process.exit(1)
  }

  console.log(`✅ Loaded ${adapters.length} adapter(s): ${adapters.map(a => a.name).join(', ')}`)

  // -----------------------------------------------------------------------------
  // 创建消息路由器（为每个适配器创建独立的路由器）
  // -----------------------------------------------------------------------------
  const routers: MessageRouter[] = []

  for (const config of adapters) {
    // 合并 admin users（适配器特定的 + 全局的）
    const adminUsers = config.adminUsers

    console.log(`🔒 ${config.name} admin users: ${adminUsers.length > 0 ? adminUsers.join(', ') : 'all users'}`)

    // 创建路由器
    const router = new MessageRouter(
      registry,
      config.adapter,
      adminUsers,
      config.name === 'telegram' ? telegramChats : [] // 只有 Telegram 支持 chat 限制
    )
    routers.push(router)

    // 设置消息处理器
    config.adapter.onMessage((message) => {
      router.handleMessage(message).catch(console.error)
    })

    config.adapter.onCallback((callback) => {
      router.handleCallback(callback).catch(console.error)
    })

    // 设置实例事件处理器
    wsServer.onEvent((instanceId, eventType, data) => {
      router.handleInstanceEvent(instanceId, eventType, data).catch(console.error)
    })

    // Discord 特殊处理：实例连接/断开通知
    if (config.name === 'discord') {
      const seenInstances = new Set<string>()
      const instanceWorkspaces = new Map<string, string>()

      wsServer.onInstanceConnect((instanceId, workspace) => {
        instanceWorkspaces.set(instanceId, workspace)
        const isReconnect = seenInstances.has(instanceId)
        seenInstances.add(instanceId)
        const reason = isReconnect ? 'reconnect' : 'connect'
        console.log(`[Discord] Instance ${instanceId} ${reason}ed (workspace: ${workspace})`)
        ;(config.adapter as DiscordAdapter).getOrCreateThread(instanceId, workspace, reason).then((threadId) => {
          console.log(`[Discord] Thread ready for ${instanceId}: ${threadId}`)
        }).catch((err) => {
          console.error(`[Discord] Failed to get/create thread for ${instanceId}:`, err)
        })
      })

      wsServer.onInstanceDisconnect((instanceId) => {
        console.log(`[Discord] Instance ${instanceId} disconnected, sending disconnect notification...`)
        const workspace = instanceWorkspaces.get(instanceId)
        ;(config.adapter as DiscordAdapter).sendDisconnectNotification(instanceId, workspace).catch(console.error)
      })
    }
  }

  // -----------------------------------------------------------------------------
  // 启动所有适配器
  // -----------------------------------------------------------------------------
  for (const config of adapters) {
    await config.adapter.start()
    console.log(`✅ ${config.name} adapter started`)
  }

  console.log('')
  console.log('✅ Bridge Hub started successfully!')
  console.log('')
  console.log('📋 Usage:')
  adapters.forEach(config => {
    console.log(`   - Use ${config.name} to interact with instances`)
  })
  console.log('')

  // -----------------------------------------------------------------------------
  // 优雅关闭
  // -----------------------------------------------------------------------------
  const shutdown = () => {
    console.log('\n🛑 Shutting down...')
    adapters.forEach(config => config.adapter.stop())
    wsServer.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('Failed to start Bridge Hub:', err)
  process.exit(1)
})
