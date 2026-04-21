// Test script to verify code block handling

import { markdownToEntities, splitEntities } from './bridge-hub/dist/core/markdown-entities.js';

// Simulate DiscordAdapter.entitiesToMarkdown
function entitiesToMarkdown(text, entities) {
  if (!entities || entities.length === 0) return text;
  
  const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);
  let result = text;
  
  for (const entity of sortedEntities) {
    const { type, offset, length, language } = entity;
    const content = result.substring(offset, offset + length);
    
    let replacement;
    switch (type) {
      case 'pre':
        if (language) {
          replacement = `\`\`\`${language}\n${content}\n\`\`\``;
        } else {
          replacement = `\`\`\`\n${content}\n\`\`\``;
        }
        break;
      case 'code':
        replacement = `\`${content}\``;
        break;
      case 'bold':
        replacement = `**${content}**`;
        break;
      default:
        replacement = content;
    }
    
    result = result.substring(0, offset) + replacement + result.substring(offset + length);
  }
  
  return result;
}

// Test 1: Simple code block
console.log('=== Test 1: Simple code block ===');
const markdown1 = `Here's some code:

\`\`\`javascript
function hello() {
  console.log('Hello World');
}
\`\`\`

End of message.`;

console.log('Input Markdown:');
console.log(markdown1);
console.log('\n');

const result1 = markdownToEntities(markdown1);
console.log('After markdownToEntities:');
console.log('Text:', JSON.stringify(result1.text));
console.log('Entities:', JSON.stringify(result1.entities, null, 2));
console.log('\n');

const recovered1 = entitiesToMarkdown(result1.text, result1.entities);
console.log('After entitiesToMarkdown:');
console.log(recovered1);
console.log('\n\n');

// Test 2: With splitting
console.log('=== Test 2: With message splitting ===');
const chunks = splitEntities(result1.text, result1.entities, 100);
console.log(`Split into ${chunks.length} chunks`);

chunks.forEach((chunk, i) => {
  console.log(`\n--- Chunk ${i + 1} ---`);
  console.log('Text:', JSON.stringify(chunk.text));
  console.log('Entities:', JSON.stringify(chunk.entities, null, 2));
  
  const recovered = entitiesToMarkdown(chunk.text, chunk.entities);
  console.log('Recovered Markdown:');
  console.log(recovered);
});

console.log('\n\n=== Test 3: Inline code ===');
const markdown3 = 'Use the `console.log()` function to print output.';
const result3 = markdownToEntities(markdown3);
console.log('Input:', markdown3);
console.log('Text:', JSON.stringify(result3.text));
console.log('Entities:', JSON.stringify(result3.entities, null, 2));
console.log('Recovered:', entitiesToMarkdown(result3.text, result3.entities));

console.log('\n\n=== Test 4: Empty code block ===');
const markdown4 = `Empty code:

\`\`\`typescript

\`\`\`

Done.`;
const result4 = markdownToEntities(markdown4);
console.log('Input:', markdown4);
console.log('Text:', JSON.stringify(result4.text));
console.log('Entities:', JSON.stringify(result4.entities, null, 2));
console.log('Recovered:', entitiesToMarkdown(result4.text, result4.entities));
