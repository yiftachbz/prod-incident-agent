# ── Stage 1: build ─────────────────────────────────────────────────────────
FROM node:22-slim AS build

WORKDIR /app
COPY package.json ./
RUN npm install

COPY index.html vite.config.js ./
COPY src/ ./src/
COPY public/ ./public/ 2>/dev/null || true

# VITE_API_URL must be the full origin of the app-server at build time,
# e.g. https://api.example.com  (no trailing slash, no path).
# Leave empty to use relative paths (only works when frontend and server
# share the same origin / are behind the same load-balancer).
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

# ── Stage 2: serve ──────────────────────────────────────────────────────────
FROM nginx:stable-alpine

COPY --from=build /app/dist /usr/share/nginx/html

# Nginx config: serve SPA, forward /api/* to the app server.
# APP_SERVER_URL is substituted at container start via envsubst.
COPY nginx.conf /etc/nginx/templates/default.conf.template

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
