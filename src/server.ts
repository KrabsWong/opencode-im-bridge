import type { Plugin, PluginModule, Hooks } from "@opencode-ai/plugin"
import type { IMBridgeOptions, IMAdapter } from "./types/index.js"
import { IMBridge } from "./core/bridge.js"
import { IMBridgeLogger } from "./core/logger.js"
import { TelegramAdapter } from "./adapters/telegram.js"

// Global logger for plugin-level logging
const pluginLogger = new IMBridgeLogger(".opencode/im-bridge-plugin.log")

// Adapter registry
const adapters: Record<string, new () => IMAdapter> = {
  telegram: TelegramAdapter,
}

// Store bridge state globally for command access
let bridgeState: {
  bridge?: IMBridge
  adapter?: IMAdapter
  options?: IMBridgeOptions
  isInitialized: boolean
  input?: any
} = {
  isInitialized: false,
}

// Skill instruction that will be injected into system prompt
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
 * Initialize the bridge
 */
async function initializeBridge(): Promise<string> {
  if (bridgeState.isInitialized) {
    return "IM Bridge is already running"
  }

  if (!bridgeState.options || !bridgeState.input) {
    return "IM Bridge not configured"
  }

  const options = bridgeState.options

  try {
    pluginLogger.info(`[IMBridgePlugin] Initializing ${options.platform} adapter...`)

    let AdapterClass: new () => IMAdapter
    if (options.platform === "custom") {
      if (!options.customAdapter) {
        throw new Error("IM Bridge: customAdapter is required when platform is 'custom'")
      }
      AdapterClass = options.customAdapter
    } else {
      AdapterClass = adapters[options.platform]
      if (!AdapterClass) {
        throw new Error(`IM Bridge: Unknown platform '${options.platform}'`)
      }
    }

    const adapter = new AdapterClass()
    const bridge = new IMBridge(adapter, bridgeState.input, options.bridgeConfig)

    await adapter.initialize(options.platformConfig)
    await bridge.initialize()

    bridgeState.bridge = bridge
    bridgeState.adapter = adapter
    bridgeState.isInitialized = true

    pluginLogger.info(`[IMBridgePlugin] Initialized with ${options.platform} adapter`)
    return `IM Bridge started successfully with ${options.platform}`
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    pluginLogger.error("[IMBridgePlugin] Failed to initialize:", error)
    return `Failed to start: ${errorMsg}`
  }
}

/**
 * Stop the bridge
 */
async function stopBridge(): Promise<string> {
  if (!bridgeState.isInitialized || !bridgeState.bridge) {
    return "IM Bridge is not running"
  }

  try {
    await bridgeState.bridge.stop()
    bridgeState.isInitialized = false
    bridgeState.bridge = undefined
    bridgeState.adapter = undefined
    pluginLogger.info("[IMBridgePlugin] Stopped")
    return "IM Bridge stopped successfully"
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    pluginLogger.error("[IMBridgePlugin] Failed to stop:", error)
    return `Failed to stop: ${errorMsg}`
  }
}

/**
 * OpenCode IM Bridge Plugin
 *
 * Auto-injects skill instructions into system prompt for AI to use image sending capability.
 */
const IMBridgePlugin: Plugin = async (input, options: IMBridgeOptions) => {
  // Validate options
  if (!options?.platform) {
    throw new Error("IM Bridge: platform option is required")
  }

  if (!options?.platformConfig) {
    throw new Error("IM Bridge: platformConfig option is required")
  }

  // Store for later initialization
  bridgeState.options = options
  bridgeState.input = input

  pluginLogger.info("[IMBridgePlugin] Loaded. Image sending skill auto-injected into system prompt.")

  const autoStart = options.autoStart === true

  // Return hooks
  const hooks: Hooks = {
    // Inject skill instructions into system prompt - this teaches AI when/how to send images
    "experimental.chat.system.transform": async (_input, output) => {
      if (!output.system) {
        output.system = []
      }
      if (Array.isArray(output.system)) {
        output.system.push(TELEGRAM_IMAGE_SKILL_INSTRUCTION)
      }
    },

    // Listen to events only when initialized
    event: async ({ event }) => {
      if (!bridgeState.isInitialized || !bridgeState.bridge) {
        return
      }

      const bridge = bridgeState.bridge

      try {
        switch (event.type) {
          case "question.asked": {
            const { id, sessionID, questions } = event.properties
            await bridge.onQuestionAsked({
              id,
              sessionId: sessionID,
              questions: questions.map((q: any) => ({
                header: q.header || "Question",
                question: q.question,
                options: q.options || [],
                multiple: q.multiple,
              })),
            })
            break
          }

          case "question.replied": {
            const { requestID } = event.properties
            await bridge.onQuestionReplied(requestID)
            break
          }

          case "permission.asked": {
            const { id, sessionID, permission, patterns, metadata } = event.properties
            await bridge.onPermissionAsked({
              id,
              sessionId: sessionID,
              permission,
              patterns: patterns || [],
              metadata: metadata || {},
            })
            break
          }

          case "permission.replied": {
            const { requestID } = event.properties
            await bridge.onPermissionReplied(requestID)
            break
          }

          case "session.created": {
            const { sessionID, info } = event.properties
            await bridge.onSessionCreated(sessionID, info)
            break
          }
        }
      } catch (error) {
        pluginLogger.error("[IMBridgePlugin] Error handling event:", error)
      }
    },
  }

  // Auto-start if enabled
  if (autoStart) {
    pluginLogger.info("[IMBridgePlugin] Auto-start enabled, starting...")
    pluginLogger.info(`[IMBridgePlugin] Config: platform=${options.platform}`)
    pluginLogger.flush().catch(() => {})
    initializeBridge().then(async () => {
      await pluginLogger.flush()
    }).catch((error) => {
      pluginLogger.error("[IMBridgePlugin] Auto-start failed:", error)
      pluginLogger.flush().catch(() => {})
    })
  } else {
    pluginLogger.info("[IMBridgePlugin] Auto-start disabled. Set autoStart: true in config to enable.")
    pluginLogger.flush().catch(() => {})
  }

  // Cleanup on shutdown
  process.on("SIGINT", async () => {
    if (bridgeState.isInitialized) {
      pluginLogger.info("[IMBridgePlugin] Shutting down...")
      await stopBridge()
    }
    pluginLogger.stop()
  })

  process.on("SIGTERM", async () => {
    if (bridgeState.isInitialized) {
      await stopBridge()
    }
    pluginLogger.stop()
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
export * from "./core/bridge.js"
export { TelegramAdapter } from "./adapters/telegram.js"
