FROM node:20-bookworm-slim AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# better-sqlite3 may require native build toolchain during npm install.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS run

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# SQLite data directory
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

EXPOSE 3000
USER node

CMD ["node", "server.js"]
