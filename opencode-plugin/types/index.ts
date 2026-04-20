/**
 * OpenCode Bridge Hub - Plugin Types
 * 
 * Plugin connects to Bridge Hub as a WebSocket client.
 * Bridge Hub handles all IM platform communication.
 */

// ============ Hub Client Types ============

export interface HubConfig {
  /** Bridge Hub WebSocket URL (e.g., ws://localhost:38471) */
  hubUrl: string
  
  /** Unique instance ID (auto-generated from directory if not provided) */
  instanceId?: string
  
  /** Authentication token (must match Bridge Hub's AUTH_TOKEN) */
  authToken: string
}

export interface HubMessage {
  type: 'register' | 'unregister' | 'request' | 'response' | 'event' | 'ping' | 'pong' | 'error' | 'registered'
  requestId?: string
  data?: any
}

export interface HubRequest {
  type: 'prompt' | 'command' | 'question_reply' | 'permission_reply'
  [key: string]: any
}

// ============ OpenCode Event Types ============

export interface QuestionInfo {
  id: string
  sessionId: string
  questions: Array<{
    header: string
    question: string
    options: Array<{
      label: string
      description: string
    }>
    multiple?: boolean
  }>
}

export interface PermissionInfo {
  id: string
  sessionId: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
}

export interface SessionInfo {
  id: string
  title?: string
  time?: {
    created?: string
    updated?: string
  }
}

// ============ Plugin Options ============

export interface IMBridgeOptions {
  /** Bridge Hub configuration */
  hubConfig: HubConfig
}
