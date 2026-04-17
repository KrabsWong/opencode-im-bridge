import { TelegramAdapter } from "opencode-im-bridge/adapters/telegram"
import type { IMAdapter, IMMessage, IMOutgoingMessage } from "opencode-im-bridge/types"

/**
 * Example: Creating a custom adapter
 * 
 * This shows how to implement the IMAdapter interface for a new platform.
 */

export class ExampleAdapter implements IMAdapter {
  readonly name = "example"
  readonly version = "1.0.0"
  
  private messageHandler?: (message: IMMessage) => void
  private config: Record<string, unknown> = {}
  
  async initialize(config: Record<string, unknown>): Promise<void> {
    this.config = config
    console.log(`[ExampleAdapter] Initialized with config:`, config)
  }
  
  async sendMessage(message: IMOutgoingMessage): Promise<{ messageId: string }> {
    console.log(`[ExampleAdapter] Sending message:`, message.text)
    // Platform-specific send logic here
    return { messageId: "msg_" + Date.now() }
  }
  
  async editMessage(messageId: string, message: IMOutgoingMessage): Promise<void> {
    console.log(`[ExampleAdapter] Editing message ${messageId}:`, message.text)
  }
  
  async deleteMessage(messageId: string): Promise<void> {
    console.log(`[ExampleAdapter] Deleting message ${messageId}`)
  }
  
  onMessage(handler: (message: IMMessage) => void): void {
    this.messageHandler = handler
  }
  
  onCallback(): void {
    // Not implemented in this example
  }
  
  async start(): Promise<void> {
    console.log("[ExampleAdapter] Started")
    
    // Simulate receiving a message after 5 seconds
    setTimeout(() => {
      if (this.messageHandler) {
        this.messageHandler({
          id: "test_msg",
          user: { id: "user_1", name: "Test User" },
          text: "/status",
          timestamp: new Date(),
          raw: {},
        })
      }
    }, 5000)
  }
  
  async stop(): Promise<void> {
    console.log("[ExampleAdapter] Stopped")
  }
}

/**
 * Example configuration for different platforms
 */
export const examples = {
  // Telegram with long polling
  telegramPolling: {
    platform: "telegram",
    platformConfig: {
      botToken: "YOUR_BOT_TOKEN",
      chatId: "YOUR_CHAT_ID",
    },
  },
  
  // Telegram with webhook
  telegramWebhook: {
    platform: "telegram",
    platformConfig: {
      botToken: "YOUR_BOT_TOKEN",
      chatId: "YOUR_CHAT_ID",
      webhookUrl: "https://your-server.com/webhook",
      webhookPort: 3000,
    },
  },
  
  // With all bridge options
  fullConfig: {
    platform: "telegram",
    platformConfig: {
      botToken: "YOUR_BOT_TOKEN",
      chatId: "YOUR_CHAT_ID",
    },
    bridgeConfig: {
      adminUsers: ["123456789"],
      allowedChats: ["-1001234567890"],
      features: {
        questions: true,
        permissions: true,
        statusQuery: true,
        directMessaging: true,
        autoStatus: true,
      },
      sessionStrategy: "latest",
    },
  },
  
  // Custom adapter
  custom: {
    platform: "custom",
    customAdapter: ExampleAdapter,
    platformConfig: {
      // Custom config
    },
  },
}

export default ExampleAdapter
