FROM oven/bun:1.3.14-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

USER bun
CMD ["bun", "run", "src/server.ts"]
