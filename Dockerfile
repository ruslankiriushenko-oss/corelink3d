# CoreLink 3D — Docker Image
FROM node:20-alpine

LABEL maintainer="CoreLink 3D"
LABEL description="AI-powered 3D viewport with local LLM integration"

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application
COPY server/ ./server/
COPY public/ ./public/

# Create uploads directory
RUN mkdir -p /app/uploads

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

# Start
CMD ["node", "server/index.js"]
