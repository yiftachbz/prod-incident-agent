FROM node:22-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/

ENV SERVER_PORT=3001

EXPOSE 3001

USER node
CMD ["node", "src/index.js"]
