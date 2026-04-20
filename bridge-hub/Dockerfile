FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build
RUN npm run build

# Expose port (default 38471, but can be overridden)
EXPOSE ${PORT:-38471}

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(() => process.exit(0)).catch(() => process.exit(1))"

# Start
CMD ["npm", "start"]
