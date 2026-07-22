FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

RUN npx tsc

ENV NODE_ENV=production

CMD ["node", "dist/liquidator.js"]
