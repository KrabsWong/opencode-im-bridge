import type { Plugin, PluginModule, Hooks } from "@opencode-ai/plugin"
import type { IMBridgeOptions, QuestionInfo, PermissionInfo } from "./types/index.js"
import { HubClient } from "./core/hub-client.js"
import { IMBridgeLogger } from "./core/logger.js"

// Global logger
const logger = new IMBridgeLogger(".opencode/bridge-plugin.log")

// Skill instruction for AI image sending
const TELEGRAM_IMAGE_SKILL_INSTRUCTION = `
## Image Sending Rule (CRITICAL)

When user asks for images/diagrams (架构图, architecture, etc):
1. ALWAYS include: [SEND_IMAGE_TO_IM]
2. Confirm image was sent (e.g., "图片已发送", "Image sent")
3. NEVER say you "cannot send", "无法访问", or "can't access"
4. NEVER explain technical limitations

**CORRECT Examples:**
User: "给我看看架构图"
You: "[SEND_IMAGE_TO_IM] 图片已发送至 Telegram"

User: "架构图"
You: "[SEND_IMAGE_TO_IM] 已发送"

User: "send architecture"
You: "[SEND_IMAGE_TO_IM] Sent to your Telegram"

**WRONG (Don't do this):**
❌ "我无法直接发送图片"
❌ "I cannot access your system"
❌ "你需要手动发送"

The marker [SEND_IMAGE_TO_IM] will be processed automatically. Just confirm it was sent.
`

/**
 * OpenCode IM Bridge Plugin - Hub Client Mode
 * 
 * This plugin connects to a Bridge Hub service as a WebSocket client.
 * The Bridge Hub handles all IM platform communication (Telegram, etc.)
 */
const IMBridgePlugin: Plugin = async (input, options: IMBridgeOptions) => {
  // Validate options
  if (!options?.hubConfig) {
    throw new Error("IM Bridge: hubConfig is required")
  }

  if (!options.hubConfig.hubUrl) {
    throw new Error("IM Bridge: hubConfig.hubUrl is required")
  }

  if (!options.hubConfig.authToken) {
    throw new Error("IM Bridge: hubConfig.authToken is required")
  }

  logger.info("[IMBridgePlugin] Starting Hub Client mode...")
  logger.info(`[IMBridgePlugin] Hub URL: ${options.hubConfig.hubUrl}`)
  logger.info(`[IMBridgePlugin] Instance ID: ${options.hubConfig.instanceId || 'auto-generated'}`)

  // Create Hub Client
  const hubClient = new HubClient(options.hubConfig, input)

  // Connect to Bridge Hub
  try {
    await hubClient.connect()
    logger.info("[IMBridgePlugin] Connected to Bridge Hub")
  } catch (err) {
    logger.error("[IMBridgePlugin] Failed to connect to Bridge Hub:", err)
    // Don't throw - let it retry in background
  }

  // Return hooks
  const hooks: Hooks = {
    // Inject skill instructions into system prompt
    "experimental.chat.system.transform": async (_input, output) => {
      if (!output.system) {
        output.system = []
      }
      if (Array.isArray(output.system)) {
        output.system.push(TELEGRAM_IMAGE_SKILL_INSTRUCTION)
      }
    },

    // Forward OpenCode events to Bridge Hub
    event: async ({ event }) => {
      try {
        switch (event.type) {
          case "question.asked": {
            const { id, sessionID, questions } = event.properties
            const info: QuestionInfo = {
              id,
              sessionId: sessionID,
              questions: questions.map((q: any) => ({
                header: q.header || "Question",
                question: q.question,
                options: q.options || [],
                multiple: q.multiple,
              })),
            }
            await hubClient.sendEvent('question.asked', info)
            break
          }

          case "question.replied": {
            const { requestID } = event.properties
            await hubClient.sendEvent('question.replied', { requestId: requestID })
            break
          }

          case "permission.asked": {
            const { id, sessionID, permission, patterns, metadata } = event.properties
            const info: PermissionInfo = {
              id,
              sessionId: sessionID,
              permission,
              patterns: patterns || [],
              metadata: metadata || {},
            }
            await hubClient.sendEvent('permission.asked', info)
            break
          }

          case "permission.replied": {
            const { requestID } = event.properties
            await hubClient.sendEvent('permission.replied', { requestId: requestID })
            break
          }

          case "session.created": {
            const { sessionID, info } = event.properties
            await hubClient.sendEvent('session.created', { sessionId: sessionID, info })
            break
          }
        }
      } catch (error) {
        logger.error("[IMBridgePlugin] Error forwarding event:", error)
      }
    },
  }

  // Cleanup on shutdown
  process.on("SIGINT", async () => {
    logger.info("[IMBridgePlugin] Shutting down...")
    hubClient.disconnect()
    logger.stop()
  })

  process.on("SIGTERM", async () => {
    hubClient.disconnect()
    logger.stop()
  })

  return hooks
}

// Export plugin module
const plugin: PluginModule & { id: string } = {
  id: "im.bridge",
  server: IMBridgePlugin,
}

export default plugin
export * from "./types/index.js"
export { HubClient } from "./core/hub-client.js"
