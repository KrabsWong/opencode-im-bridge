import 'dotenv/config'
import { HubWebSocketServer } from './server/websocket-server.js'
import { TelegramAdapter } from './adapters/telegram.js'
import { DiscordAdapter } from './adapters/discord.js'
import { MessageRouter } from './router/message-router.js'
import type { IMAdapter } from './types/index.js'

async function main() {
  // 从环境变量读取配置
  const port = parseInt(process.env.PORT || '38471')
  let authToken = process.env.AUTH_TOKEN
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const discordToken = process.env.DISCORD_BOT_TOKEN
  const discordChannelId = process.env.DISCORD_CHANNEL_ID
  const useDiscord = process.env.USE_DISCORD === 'true'
  const adminUsers = (process.env.ADMIN_USERS || '').split(',').filter(Boolean)
  const allowedChats = (process.env.ALLOWED_CHATS || '').split(',').filter(Boolean)

  // 检查 adapter 配置
  const hasTelegram = !!botToken
  const hasDiscord = !!discordToken && !!discordChannelId

  if (!hasTelegram && !hasDiscord) {
    console.error('Error: At least one adapter (TELEGRAM_BOT_TOKEN or DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID) is required')
    process.exit(1)
  }

  // 如果没有设置 AUTH_TOKEN，自动生成一个
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

  console.log('🚀 Starting Bridge Hub...')
  console.log(`📡 WebSocket port: ${port}`)
  console.log(`👥 Admin users: ${adminUsers.length > 0 ? adminUsers.join(', ') : 'all users'}`)
  console.log(`💬 Allowed chats: ${allowedChats.length > 0 ? allowedChats.join(', ') : 'all chats'}`)

  // 创建 WebSocket 服务器
  const wsServer = new HubWebSocketServer(port, authToken)
  const registry = wsServer.getRegistry()

  // 创建适配器
  let adapter: IMAdapter | null = null
  const adapters: IMAdapter[] = []

  // Discord 优先级更高（如果明确指定）
  if (useDiscord && hasDiscord) {
    console.log('📱 Using Discord adapter')
    const discord = new DiscordAdapter()
    await discord.initialize({
      botToken: discordToken,
      channelId: discordChannelId
    })
    adapter = discord
    adapters.push(discord)
  } else if (hasTelegram) {
    console.log('📱 Using Telegram adapter')
    const telegram = new TelegramAdapter(botToken)
    
    // 验证 bot token
    try {
      const botInfo = await telegram.getMe()
      console.log(`🤖 Telegram Bot: @${botInfo.username}`)
    } catch (err) {
      console.error('❌ Failed to validate Telegram bot token:', err)
      process.exit(1)
    }
    
    adapter = telegram
    adapters.push(telegram)
  } else if (hasDiscord) {
    console.log('📱 Using Discord adapter')
    const discord = new DiscordAdapter()
    await discord.initialize({
      botToken: discordToken,
      channelId: discordChannelId
    })
    adapter = discord
    adapters.push(discord)
  }

  if (!adapter) {
    console.error('❌ No adapter available')
    process.exit(1)
  }

  // 创建消息路由器
  const router = new MessageRouter(registry, adapter, adminUsers, allowedChats)

  // 设置消息处理器
  adapter.onMessage((message) => {
    router.handleMessage(message).catch(console.error)
  })

  adapter.onCallback((callback) => {
    router.handleCallback(callback).catch(console.error)
  })

  // 设置事件处理器（处理 question.asked, permission.asked 等）
  wsServer.onEvent((instanceId, eventType, data) => {
    router.handleInstanceEvent(instanceId, eventType, data).catch(console.error)
  })

  // 设置 instance 连接处理器（用于创建 Discord thread）
  if (adapter instanceof DiscordAdapter) {
    wsServer.onInstanceConnect((instanceId, workspace) => {
      console.log(`[Discord] Instance ${instanceId} connected, creating thread...`)
      adapter.getOrCreateThread(instanceId, workspace).then((threadId) => {
        console.log(`[Discord] Thread created for ${instanceId}: ${threadId}`)
      }).catch((err) => {
        console.error(`[Discord] Failed to create thread for ${instanceId}:`, err)
      })
    })
  }

  // 设置 instance 断开处理器（发送断开通知，但不归档，依赖 Discord 7 天自动归档）
  if (adapter instanceof DiscordAdapter) {
    wsServer.onInstanceDisconnect((instanceId) => {
      console.log(`[Discord] Instance ${instanceId} disconnected, sending disconnect notification...`)
      adapter.sendDisconnectNotification(instanceId).catch(console.error)
    })
  }

  // 启动所有适配器
  for (const a of adapters) {
    await a.start()
  }

  console.log('✅ Bridge Hub started successfully!')
  console.log('')
  console.log('📋 Usage:')
  console.log(`   1. Configure plugins to connect to this hub`)
  console.log(`   2. Use ${adapter.name} to interact with instances`)
  console.log('')

  // 优雅关闭
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...')
    for (const a of adapters) {
      a.stop()
    }
    wsServer.stop()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...')
    for (const a of adapters) {
      a.stop()
    }
    wsServer.stop()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('Failed to start Bridge Hub:', err)
  process.exit(1)
})

/**
 * Generate a random secure token
 */
function generateRandomToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let token = 'hub-'
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return token
}
