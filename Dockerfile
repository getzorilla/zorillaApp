FROM node:22-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV ZORILLA_HOME=/data
ENV ZORILLA_PORT=5177
ENV ZORILLA_NO_OPEN=1
VOLUME ["/data"]

EXPOSE 5177

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -sf "http://127.0.0.1:${ZORILLA_PORT}/api/state" > /dev/null || exit 1

CMD ["node", "src/server/index.js"]
