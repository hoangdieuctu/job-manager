FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data

ENV DATA_DIR=/app/data

EXPOSE 3000

ENV NODE_ENV=production

ENV NODE_NO_WARNINGS=1

CMD ["node", "server.js"]
