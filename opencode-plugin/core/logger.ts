/**
 * In-memory logger with periodic file flush
 */
export class IMBridgeLogger {
  private buffer: Array<{ timestamp: string; level: string; message: string; data?: unknown }> = []
  private readonly maxBufferSize = 1000
  private readonly flushInterval = 5 * 60 * 1000 // 5 minutes
  private readonly logFile: string
  private flushTimer?: ReturnType<typeof setInterval>

  constructor(logFile: string = ".opencode/im-bridge.log") {
    this.logFile = logFile
    this.startFlushTimer()
  }

  private startFlushTimer() {
    this.flushTimer = setInterval(() => this.flush(), this.flushInterval)
  }

  private formatLogEntry(entry: { timestamp: string; level: string; message: string; data?: unknown }): string {
    let line = `[${entry.timestamp}] [${entry.level}] ${entry.message}`
    if (entry.data !== undefined) {
      try {
        const dataStr = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data)
        line += ` ${dataStr}`
      } catch {
        line += ` [unserializable data]`
      }
    }
    return line
  }

  log(level: string, message: string, data?: unknown) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data
    }

    this.buffer.push(entry)

    // Keep only last maxBufferSize entries
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer = this.buffer.slice(-this.maxBufferSize)
    }
  }

  debug(message: string, data?: unknown) {
    this.log("DEBUG", message, data)
  }

  info(message: string, data?: unknown) {
    this.log("INFO", message, data)
  }

  warn(message: string, data?: unknown) {
    this.log("WARN", message, data)
  }

  error(message: string, data?: unknown) {
    this.log("ERROR", message, data)
  }

  async flush() {
    if (this.buffer.length === 0) return

    try {
      const entries = this.buffer.map(e => this.formatLogEntry(e)).join("\n") + "\n"

      // Try to append to existing file or create new one
      const file = Bun.file(this.logFile)
      const exists = await file.exists()

      if (exists) {
        const existing = await file.text()
        await Bun.write(this.logFile, existing + entries)
      } else {
        await Bun.write(this.logFile, entries)
      }

      // Clear buffer after successful flush
      this.buffer = []
    } catch (err) {
      // Silent fail - don't throw during logging
    }
  }

  getRecentEntries(count: number = 50): string {
    return this.buffer.slice(-count).map(e => this.formatLogEntry(e)).join("\n")
  }

  stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
    }
    // Final flush
    this.flush()
  }
}