FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY docs/api ./docs/api

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "src/main.ts"]
