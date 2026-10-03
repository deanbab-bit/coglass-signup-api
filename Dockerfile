FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
# Idempotency records for /internal/provision. Mount a persistent volume here
# (e.g. -v coglass-signup-api-data:/app/data) or they are lost on recreate.
RUN mkdir -p /app/data
EXPOSE 3001
CMD ["node", "index.js"]
