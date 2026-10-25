# BLACKHOLE Terminal — stream sidecar (socket.io price/quote fan-out).
# Auto-started by docker-compose.yml (the review's Real-time item: the stream
# service must come up with the app, not by hand).
FROM oven/bun:1
WORKDIR /svc
COPY package.json ./
RUN bun install
COPY . .
EXPOSE 3030
HEALTHCHECK --interval=20s --timeout=4s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3030/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "index.ts"]
