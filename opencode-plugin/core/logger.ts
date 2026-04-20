/// <reference lib="es2020" />

declare const process: {
  cwd(): string
}

declare const require: {
  (id: string): any
}

/**
 * File-based logger for Node.js
 */
export class IMBridgeLogger {
  private logFile: string
  private fs: any
  private path: any

  constructor(logFile: string = ".opencode/hub-client.log") {
    this.logFile = logFile
    
    // Lazy load fs and path modules
    try {
      this.fs = require('fs')
      this.path = require('path')
      
      // Ensure directory exists
      this.fs.mkdirSync(this.path.dirname(this.logFile), { recursive: true })
    } catch {
      // Directory may already exist or modules not available
    }
  }

  private write(level: string, message: string, data?: unknown) {
    if (!this.fs) return
    
    const timestamp = new Date().toISOString()
    let line = `[${timestamp}] [${level}] ${message}`
    if (data !== undefined) {
      try {
        const dataStr = typeof data === 'string' ? data : JSON.stringify(data)
        line += ` ${dataStr}`
      } catch {
        line += ` [unserializable data]`
      }
    }
    line += "\n"

    try {
      this.fs.appendFileSync(this.logFile, line)
    } catch {
      // Silent fail - don't throw during logging
    }
  }

  debug(message: string, data?: unknown) {
    this.write("DEBUG", message, data)
  }

  info(message: string, data?: unknown) {
    this.write("INFO", message, data)
  }

  warn(message: string, data?: unknown) {
    this.write("WARN", message, data)
  }

  error(message: string, data?: unknown) {
    this.write("ERROR", message, data)
  }

  getRecentEntries(count: number = 50): string {
    if (!this.fs) return ''
    
    try {
      if (!this.fs.existsSync(this.logFile)) {
        return ''
      }
      const content = this.fs.readFileSync(this.logFile, 'utf-8')
      const lines = content.split('\n').filter((line: string) => line.trim())
      return lines.slice(-count).join('\n')
    } catch {
      return ''
    }
  }

  stop() {
    // No-op for compatibility - file writes are immediate now
  }
}