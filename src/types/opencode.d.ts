/**
 * Type declarations for OpenCode dependencies
 * These are simplified types for building the plugin independently
 */

declare module "@opencode-ai/plugin" {
  export interface PluginInput {
    client: OpencodeClient
    serverUrl: URL
    directory: string
  }

  export interface OpencodeClient {
    session: SessionClient
  }

  export interface SessionClient {
    list(): Promise<{ data?: Array<{ id: string; title?: string; time?: { updated?: string } }> }>
    get(params: { path: { id: string } }): Promise<{ data?: { id: string; title?: string } }>
    status(params: { path: { id: string } }): Promise<{ data?: { type?: string } }>
    todo(params: { path: { id: string } }): Promise<{ data?: { todos?: Array<{ completed: boolean }> } }>
    prompt(params: {
      path: { id: string }
      body: { parts: Array<{ type: string; text: string }> }
    }): Promise<{ data?: unknown; error?: unknown }>
  }

  export interface Hooks {
    event?: (context: { event: any }) => Promise<void>
    "experimental.chat.system.transform"?: (
      input: { sessionID?: string; model: any },
      output: { system: string[] }
    ) => Promise<void>
  }

  export type Plugin = (input: PluginInput, options: any) => Promise<Hooks>
  export type PluginModule = { server: Plugin }
}
