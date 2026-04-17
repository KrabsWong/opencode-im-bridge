# Telegram Image Sender Skill

A standard OpenCode skill for sending images to Telegram through the IM Bridge plugin.

## Structure

```
telegram-image-sender/
├── SKILL.md                      # Main skill definition
├── evals/
│   └── evals.json               # Test cases
├── references/
│   ├── technical-spec.md        # Technical implementation details
│   └── usage-examples.md        # Scenario-based usage examples
└── README.md                    # This file
```

## Installation

1. Copy this directory to your OpenCode skills directory:
   ```bash
   cp -r telegram-image-sender ~/.config/opencode/skills/
   ```

2. Restart OpenCode to load the skill

3. The skill will automatically trigger when users request diagrams

## How It Works

When you (the AI) detect a user wants to see a diagram, include this marker in your response:

```
[SEND_IMAGE:architecture]
```

The IM Bridge plugin will:
1. Detect the marker
2. Send the corresponding image to Telegram
3. Remove the marker from the visible message

## Usage Examples

See `references/usage-examples.md` for detailed scenarios.

Quick example:

```
User: "给我看看架构图"

You: 这是系统的架构图：

[SEND_IMAGE:architecture]

架构包含三个主要组件：Telegram Bot、IM Bridge 和 OpenCode。
```

## Testing

Run the evals to verify the skill works correctly:

```bash
# Evals are defined in evals/evals.json
# Test prompts include:
# - "给我看看架构图"
# - "show me the architecture diagram"
# - "系统是怎么设计的？"
# - etc.
```

## Available Images

| ID | File | Description |
|---|------|-------------|
| `architecture` | `architecture.png` | System architecture diagram |

## Adding New Images

1. Add image file to the plugin's assets directory
2. Update `IMAGE_LIBRARY` in `src/core/bridge.ts`
3. Update the "Available Images" table in `SKILL.md`
4. Rebuild and restart

## Dependencies

- OpenCode IM Bridge plugin must be installed and running
- Telegram Bot must be configured and connected
- Image files must exist at the configured paths
