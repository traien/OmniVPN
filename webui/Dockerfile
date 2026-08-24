FROM node:20-alpine

# Install Docker CLI, bash, wireguard-tools and native compilation dependencies for SQLite
RUN apk add --no-cache docker-cli bash wireguard-tools python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Expose WebUI (8080) and DNS Proxy (53/udp, 53/tcp)
EXPOSE 8080 53/udp 53/tcp

CMD ["node", "server.js"]
