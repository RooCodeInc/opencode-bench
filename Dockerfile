FROM oven/bun:1.2.21

# git is required to clone task repos at eval time
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

# results are written here; mount a volume to persist them
VOLUME /app/results

ENV HOST=0.0.0.0
ENV PORT=4700
EXPOSE 4700

CMD ["bun", "run", "server/index.ts"]
