FROM node:18-alpine

LABEL maintainer="bobotechnology"
LABEL description="Fitten Code to OpenAI API Proxy"

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "index.js"]
