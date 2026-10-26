ARG APK_MIRROR=https://mirrors.cloud.tencent.com
ARG NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/

FROM node:22-alpine AS deps

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY scripts/apk-add.sh /usr/local/bin/apk-add
ARG APK_MIRROR
RUN sh /usr/local/bin/apk-add python3 make g++ tzdata

COPY package.json package-lock.json ./
ARG NPM_REGISTRY
RUN npm config set registry "${NPM_REGISTRY:-https://mirrors.cloud.tencent.com/npm/}"
RUN npm ci

FROM deps AS build

ARG MODELGATE_EDITION=full
ENV MODELGATE_EDITION=${MODELGATE_EDITION}
ENV NEXT_PUBLIC_MODELGATE_EDITION=${MODELGATE_EDITION}

COPY . .
RUN npm run build
RUN rm -rf .next/standalone/data

FROM node:22-alpine AS run

ARG MODELGATE_EDITION=full
ARG APK_MIRROR
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV MODELGATE_EDITION=${MODELGATE_EDITION}
ENV NEXT_PUBLIC_MODELGATE_EDITION=${MODELGATE_EDITION}
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV TZ=Asia/Shanghai

COPY scripts/apk-add.sh /usr/local/bin/apk-add
RUN sh /usr/local/bin/apk-add tzdata libstdc++ su-exec \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
 && echo $TZ > /etc/timezone \
 && rm -f /usr/local/bin/apk-add

COPY --chown=node:node --from=build /app/.next/standalone ./
COPY --chown=node:node --from=build /app/.next/static ./.next/static
COPY --chown=node:node --from=build /app/public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
