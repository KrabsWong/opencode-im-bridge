// OpenCode IM Bridge - Main entry point

export { default } from "./server.js"
export * from "./types/index.js"
export * from "./core/bridge.js"
export { TelegramAdapter } from "./adapters/telegram.js"
export { markdownToEntities, splitEntities, utf16Length, type MarkdownConvertResult, type TelegramEntity } from "./core/markdown-entities.js"
