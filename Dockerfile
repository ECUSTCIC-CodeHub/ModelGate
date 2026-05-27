FROM node:20-alpine AS deps

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache python3 make g++ tzdata

COPY package.json package-lock.json ./
RUN npm config set registry https://mirrors.cloud.tencent.com/npm/
RUN npm ci

FROM deps AS build

COPY . .
RUN npm run build
RUN rm -rf .next/standalone/data

FROM node:20-alpine AS run

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV TZ=Asia/Shanghai

RUN apk add --no-cache tzdata libstdc++ \
  && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
  && echo $TZ > /etc/timezone

COPY --chown=node:node --from=build /app/.next/standalone ./
COPY --chown=node:node --from=build /app/.next/static ./.next/static
COPY --chown=node:node --from=build /app/public ./public

RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

EXPOSE 3000
USER node

CMD ["node", "server.js"]
