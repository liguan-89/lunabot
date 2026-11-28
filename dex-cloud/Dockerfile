FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN apk add --no-cache openssh-client openssh-keygen \
  && ssh-keygen -? 2>&1 | grep -q usage

ENV NODE_ENV=production
EXPOSE 8791
USER node

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8791/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "src/main.js"]
