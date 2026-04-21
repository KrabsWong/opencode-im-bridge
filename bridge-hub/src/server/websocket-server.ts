import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'
import type { ConnectedInstance, UserContext, HubMessage } from '../types/index.js'

export class InstanceRegistry {
  private instances: Map<string, ConnectedInstance> = new Map()
  private userContexts: Map<string, UserContext> = new Map()
  private authToken: string

  constructor(authToken: string) {
    this.authToken = authToken
  }

  // 注册新实例
  register(instance: ConnectedInstance): boolean {
    // 检查是否已存在
    if (this.instances.has(instance.id)) {
      console.log(`Instance ${instance.id} already exists, updating connection`)
      // 关闭旧连接
      const oldInstance = this.instances.get(instance.id)
      if (oldInstance && oldInstance.socket !== instance.socket) {
        oldInstance.socket.close()
      }
    }

    this.instances.set(instance.id, instance)
    console.log(`Instance registered: ${instance.id} (${instance.workspace})`)
    return true
  }

  // 注销实例
  unregister(instanceId: string): void {
    const instance = this.instances.get(instanceId)
    if (instance) {
      instance.status = 'disconnected'
      this.instances.delete(instanceId)
      console.log(`Instance unregistered: ${instanceId}`)
    }
  }

  // 验证认证令牌
  validateAuth(token: string): boolean {
    return token === this.authToken
  }

  // 获取实例
  getInstance(id: string): ConnectedInstance | undefined {
    return this.instances.get(id)
  }

  // 获取所有实例
  getAllInstances(): Array<{ id: string; workspace: string; status: string; capabilities: string[] }> {
    return Array.from(this.instances.values()).map(i => ({
      id: i.id,
      workspace: i.workspace,
      status: i.status,
      capabilities: i.capabilities
    }))
  }

  // 按 workspace 查找实例
  findByWorkspace(workspace: string): ConnectedInstance | undefined {
    return Array.from(this.instances.values()).find(i => i.workspace === workspace)
  }

  // 获取用户上下文
  getUserContext(userId: string): UserContext {
    if (!this.userContexts.has(userId)) {
      this.userContexts.set(userId, {
        userId,
        lastActivity: Date.now()
      })
    }
    return this.userContexts.get(userId)!
  }

  // 设置用户选中的实例
  setUserInstance(userId: string, instanceId: string): boolean {
    const instance = this.instances.get(instanceId)
    if (!instance) {
      return false
    }

    const context = this.getUserContext(userId)
    context.selectedInstanceId = instanceId
    context.lastActivity = Date.now()
    return true
  }

  // 获取用户当前选中的实例
  getUserInstance(userId: string): ConnectedInstance | undefined {
    const context = this.getUserContext(userId)
    if (!context.selectedInstanceId) {
      return undefined
    }
    return this.instances.get(context.selectedInstanceId)
  }

  // 设置用户选中的 session
  setUserSession(userId: string, sessionId: string): boolean {
    const context = this.getUserContext(userId)
    context.selectedSessionId = sessionId
    context.lastActivity = Date.now()
    return true
  }

  // 获取用户当前选中的 session
  getUserSession(userId: string): string | undefined {
    const context = this.getUserContext(userId)
    return context.selectedSessionId
  }

  // 清除用户选中的 session（当切换实例时）
  clearUserSession(userId: string): void {
    const context = this.getUserContext(userId)
    context.selectedSessionId = undefined
  }

  // 向指定实例发送请求并等待响应
  async sendToInstance(instanceId: string, message: any): Promise<any> {
    const instance = this.instances.get(instanceId)
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`)
    }

    if (instance.status === 'disconnected') {
      throw new Error(`Instance ${instanceId} is disconnected`)
    }

    return new Promise((resolve, reject) => {
      const requestId = generateRequestId()
      
      // 使用更长的超时时间（60分钟），因为AI响应可能需要较长时间
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Request to ${instanceId} timeout after 60 minutes`))
      }, 3600000) // 60分钟超时

      const handler = (event: MessageEvent) => {
        try {
          const response = JSON.parse(event.data as string) as HubMessage
          if (response.requestId === requestId) {
            cleanup()
            resolve(response.data)
          }
        } catch (err) {
          console.error('Error parsing response:', err)
        }
      }

      const cleanup = () => {
        clearTimeout(timeout)
        instance.socket.removeEventListener('message', handler as any)
      }

      instance.socket.addEventListener('message', handler as any)

      // 发送请求
      const request: HubMessage = {
        type: 'request',
        requestId,
        data: message
      }

      try {
        instance.socket.send(JSON.stringify(request))
      } catch (err) {
        cleanup()
        reject(err)
      }
    })
  }

  // 清理断开的实例
  cleanup(): void {
    const now = Date.now()
    for (const [id, instance] of this.instances.entries()) {
      if (instance.status === 'disconnected' || now - instance.lastPing > 120000) {
        this.unregister(id)
      }
    }
  }
}

export class HubWebSocketServer {
  private wss: WebSocketServer
  private registry: InstanceRegistry
  private eventHandlers: Array<(instanceId: string, eventType: string, data: any) => void> = []
  private connectHandlers: Array<(instanceId: string, workspace: string) => void> = []
  private disconnectHandlers: Array<(instanceId: string) => void> = []

  constructor(port: number, authToken: string) {
    this.registry = new InstanceRegistry(authToken)
    this.wss = new WebSocketServer({ port })

    this.wss.on('connection', (socket, request) => {
      this.handleConnection(socket, request)
    })

    console.log(`WebSocket server started on port ${port}`)

    // 定期清理断开的实例
    setInterval(() => this.registry.cleanup(), 30000)
  }

  // 注册事件处理器
  onEvent(handler: (instanceId: string, eventType: string, data: any) => void): void {
    this.eventHandlers.push(handler)
  }

  // 注册实例连接处理器
  onInstanceConnect(handler: (instanceId: string, workspace: string) => void): void {
    this.connectHandlers.push(handler)
  }

  // 注册实例断开处理器
  onInstanceDisconnect(handler: (instanceId: string) => void): void {
    this.disconnectHandlers.push(handler)
  }

  private handleConnection(socket: WebSocket, _request: any): void {
    console.log('New WebSocket connection')

    let instanceId: string | null = null

    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as HubMessage

        // Update lastPing for any message from registered instance
        if (instanceId) {
          const inst = this.registry.getInstance(instanceId)
          if (inst) {
            inst.lastPing = Date.now()
          }
        }

        switch (message.type) {
          case 'register':
            const registerData = message.data as {
              instanceId: string
              workspace: string
              authToken: string
              capabilities: string[]
            }

            // 验证认证
            if (!this.registry.validateAuth(registerData.authToken)) {
              socket.send(JSON.stringify({
                type: 'error',
                data: { error: 'Invalid auth token' }
              }))
              socket.close()
              return
            }

            instanceId = registerData.instanceId

            const instance: ConnectedInstance = {
              id: registerData.instanceId,
              workspace: registerData.workspace,
              socket,
              status: 'connected',
              lastPing: Date.now(),
              capabilities: registerData.capabilities || []
            }

            this.registry.register(instance)

            // 触发实例连接处理器
            this.connectHandlers.forEach(handler => {
              try {
                handler(instance.id, instance.workspace)
              } catch (err) {
                console.error('Error handling instance connect:', err)
              }
            })

            socket.send(JSON.stringify({
              type: 'registered',
              data: { success: true, instanceId }
            }))
            break

          case 'event':
            // Plugin 发送的事件（如 question.asked, permission.asked）
            // 转发给注册的处理器
            if (instanceId && message.data?.eventType) {
              console.log(`Event from ${instanceId}:`, message.data.eventType)
              const eventType = message.data.eventType as string
              const eventData = message.data
              this.eventHandlers.forEach(handler => {
                try {
                  handler(instanceId!, eventType, eventData)
                } catch (err) {
                  console.error('Error handling event:', err)
                }
              })
            }
            break

          case 'ping':
            // 心跳包 - 已在上面的通用逻辑中更新 lastPing
            socket.send(JSON.stringify({ type: 'pong' }))
            break
        }
      } catch (err) {
        console.error('Error handling message:', err)
      }
    })

    socket.on('close', () => {
      if (instanceId) {
        this.registry.unregister(instanceId)
        // 触发断开处理器
        this.disconnectHandlers.forEach(handler => {
          try {
            handler(instanceId!)
          } catch (err) {
            console.error('Error handling disconnect:', err)
          }
        })
      }
      console.log('WebSocket connection closed')
    })

    socket.on('error', (err) => {
      console.error('WebSocket error:', err)
    })
  }

  getRegistry(): InstanceRegistry {
    return this.registry
  }

  stop(): void {
    this.wss.close()
  }
}

function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}
