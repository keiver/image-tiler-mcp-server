# -- Build stage --
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && \
    npm prune --omit=dev && \
    rm -rf /root/.npm

# -- Runtime stage --
FROM node:20-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation && \
    rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
USER node
ENTRYPOINT ["node", "dist/index.js"]
