FROM node:20.19.4-alpine3.22 AS dependencies

WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false && npm cache clean --force

FROM node:20.19.4-alpine3.22

RUN apk add --no-cache bash docker-cli tini wireguard-tools \
    && mkdir -p /app/data /etc/wireguard/wg_confs /etc/xray /tmp/vpn-uploads \
    && chmod 700 /app/data /etc/wireguard /etc/wireguard/wg_confs /etc/xray /tmp/vpn-uploads

WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

EXPOSE 8080 53/udp 53/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
