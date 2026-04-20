import 'dotenv/config'
import { HubWebSocketServer } from './server/websocket-server.js'
import { TelegramAdapter } from './adapters/telegram.js'
import { MessageRouter } from './router/message-router.js'

async function main() {
  // 从环境变量读取配置（默认使用随机高端口避免冲突）
  const port = parseInt(process.env.PORT || '38471')
  let authToken = process.env.AUTH_TOKEN
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const adminUsers = (process.env.ADMIN_USERS || '').split(',').filter(Boolean)
  const allowedChats = (process.env.ALLOWED_CHATS || '').split(',').filter(Boolean)

  if (!botToken) {
    console.error('Error: TELEGRAM_BOT_TOKEN environment variable is required')
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

  // 创建 Telegram 适配器
  const telegram = new TelegramAdapter(botToken)

  // 验证 bot token
  try {
    const botInfo = await telegram.getMe()
    console.log(`🤖 Telegram Bot: @${botInfo.username}`)
  } catch (err) {
    console.error('❌ Failed to validate Telegram bot token:', err)
    process.exit(1)
  }

  // 创建消息路由器
  const router = new MessageRouter(registry, telegram, adminUsers, allowedChats)

  // 设置消息处理器
  telegram.onMessage((message) => {
    router.handleMessage(message).catch(console.error)
  })

  telegram.onCallback((callback) => {
    router.handleCallback(callback).catch(console.error)
  })

  // 设置事件处理器（处理 question.asked, permission.asked 等）
  wsServer.onEvent((instanceId, eventType, data) => {
    router.handleInstanceEvent(instanceId, eventType, data).catch(console.error)
  })

  // 启动 Telegram 轮询
  telegram.start()

  console.log('✅ Bridge Hub started successfully!')
  console.log('')
  console.log('📋 Usage:')
  console.log('   1. Configure plugins to connect to this hub')
  console.log(`   2. Use Telegram bot to interact with instances`)
  console.log('')

  // 优雅关闭
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...')
    telegram.stop()
    wsServer.stop()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...')
    telegram.stop()
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
