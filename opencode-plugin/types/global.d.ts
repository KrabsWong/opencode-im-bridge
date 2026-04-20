/**
 * Global type declarations
 */

declare const Bun: {
  serve(options: {
    port: number
    fetch: (request: Request) => Response | Promise<Response>
  }): {
    stop(): void
  }
  file(path: string): {
    exists(): Promise<boolean>
    text(): Promise<string>
    arrayBuffer(): Promise<ArrayBuffer>
    bytes(): Promise<Uint8Array>
  }
  write(path: string, data: string | Blob): Promise<number>
  $: TemplateStringsArray
}

declare namespace NodeJS {
  interface Process {
    on(event: string, listener: (...args: any[]) => void): void
    cwd(): string
  }
}

declare const process: NodeJS.Process
