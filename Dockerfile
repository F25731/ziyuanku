FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .
RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "app.js"]
