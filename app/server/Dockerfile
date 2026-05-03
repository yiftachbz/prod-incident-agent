FROM node:22-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/

# Session log directory — mount a volume here in production so the agent
# (or a log shipper) can read /app/logs/server.jsonl.
RUN mkdir -p /app/logs && chown -R node:node /app/logs
ENV LOG_PATH=/app/logs/server.jsonl

ENV SERVER_PORT=3001

EXPOSE 3001
VOLUME ["/app/logs"]

USER node
CMD ["node", "src/index.js"]
