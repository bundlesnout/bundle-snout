# Alternativa a render.yaml (cualquier host con Docker)
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8787 BOT_MODE=webhook
EXPOSE 8787
CMD ["node", "server.js"]
