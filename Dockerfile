FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
ENV TELEGRAM_BOT_TOKEN=8744188121:AAHFC0ZROat6iOoPE5D9vrWVBCXVEjef_JQ
ENV TELEGRAM_CHAT_ID=657352274
ENV POLL_INTERVAL_MS=10000

CMD ["npx", "tsx", "src/liquidator.ts"]
