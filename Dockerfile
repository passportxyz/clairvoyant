# Stage 1: Build TypeScript
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
COPY cli/ cli/
RUN npx tsc

# Stage 2: Production
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY migrations/ migrations/

RUN addgroup -S app && adduser -S app -G app
USER app

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/src/server.js"]
