# Image Trigger Technical Reference

## Marker Format Specification

### Syntax

```
[SEND_IMAGE:image_id]
[SEND_IMAGE:image_id|caption]
```

### Components

- `[SEND_IMAGE:` - Opening marker (fixed, case-sensitive)
- `image_id` - Image identifier from IMAGE_LIBRARY (lowercase, no spaces)
- `|` - Separator (optional, only if caption provided)
- `caption` - Custom caption text (optional, can contain spaces)
- `]` - Closing marker (fixed)

### Examples

Valid:
- `[SEND_IMAGE:architecture]`
- `[SEND_IMAGE:architecture|System Overview]`
- `[SEND_IMAGE:workflow|Step-by-step process diagram]`

Invalid:
- `[send_image:architecture]` (wrong case)
- `[SEND_IMAGE: architecture]` (space after colon)
- `SEND_IMAGE:architecture` (missing brackets)

## Processing Flow

```
AI Response with Marker
        ↓
Bridge.checkAndSendImagesFromResponse()
        ↓
Regex Match: /\[SEND_IMAGE:([^\]|]+)(?:\|([^\]]*))?\]/g
        ↓
For each match:
  - Extract image_id and optional caption
  - Lookup image_id in IMAGE_LIBRARY
  - If found: adapter.sendPhoto(path, caption)
  - Remove marker from response text
        ↓
Send processed text to Telegram
```

## IMAGE_LIBRARY Structure

```typescript
const IMAGE_LIBRARY: Record<string, { 
  path: string;        // Absolute path to image file
  description: string; // Default caption/description
}> = {
  architecture: {
    path: "/absolute/path/to/architecture.png",
    description: "系统架构图"
  }
}
```

## Error Handling

### Image Not Found
- Logs error: "Image not found in library: {id}"
- Continues processing other markers
- Marker removed from output

### Send Failed
- Logs error with details
- Continues processing
- Marker still removed from output
- User sees text but no image

### Adapter Not Supported
- Logs: "Adapter does not support sendPhoto"
- Skips image sending
- Marker removed from output

## Integration Points

### 1. Direct Message Handler
Location: `handleDirectMessage()`
Purpose: Detect markers in Telegram messages
Behavior: If message contains `[SEND_IMAGE:`, process and return (no session forwarding)

### 2. AI Response Handler
Location: `handleDirectMessage()` after `session.prompt()`
Purpose: Detect markers in AI responses
Behavior: Process markers before sending response to Telegram

### 3. Result
Both paths use `checkAndSendImagesFromResponse()` for consistent processing.
