FROM node:20-bookworm-slim

# зависимости для сборки better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "server.js"]
