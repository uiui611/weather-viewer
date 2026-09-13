FROM oven/bun:1.3.14-alpine AS dependencies

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    TMPDIR=/tmp

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
COPY web ./web

USER bun
EXPOSE 3000

CMD ["bun", "src/server.ts"]
