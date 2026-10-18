FROM node:22-slim
WORKDIR /app

# Install dependencies first so this layer is cached until package files change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000
USER node

# Run node directly (not via npm) so SIGTERM reaches the process and graceful shutdown works.
CMD ["node", "--import", "tsx", "src/index.ts"]
