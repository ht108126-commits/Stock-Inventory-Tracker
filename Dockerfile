# Multi-stage Dockerfile optimized for Google Cloud Run (Project: stock-notebook-8b041)
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV GCP_PROJECT_ID=stock-notebook-8b041
ENV DEFAULT_SPREADSHEET_ID=1YWMTQS-wo_HUcQsWuewAZkn6wP36C-o2P5ftgc9WDCw
ENV ALLOWED_OWNER_EMAILS=ht108126@gmail.com

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/tsconfig.json ./tsconfig.json

EXPOSE 8080

CMD ["npx", "tsx", "server/index.ts"]
