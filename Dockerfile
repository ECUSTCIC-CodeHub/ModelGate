FROM node:20-bookworm-slim AS deps

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm config set registry https://mirrors.cloud.tencent.com/npm/
RUN npm ci

FROM deps AS build

COPY . .
RUN npm run build
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-bookworm-slim AS run

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV TZ=Asia/Shanghai

RUN apt-get update \
  && apt-get install -y --no-install-recommends tzdata \
  && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
  && echo $TZ > /etc/timezone \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

EXPOSE 3000
USER node

CMD ["node", "server.js"]
