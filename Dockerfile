FROM node:22-alpine

# Java runs ViaProxy, which is only started when a bot joins a server newer than mineflayer supports
RUN apk add --no-cache openjdk21-jre-headless

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

ARG VIAPROXY_VERSION=3.4.14
ARG VIAPROXY_SHA256=2894bbfb2f4342f8fde887af6c689313efd5b0e46a8006775eea0e21e2948ab5
RUN mkdir viaproxy \
 && wget -qO viaproxy/ViaProxy.jar "https://github.com/ViaVersion/ViaProxy/releases/download/v${VIAPROXY_VERSION}/ViaProxy-${VIAPROXY_VERSION}.jar" \
 && echo "${VIAPROXY_SHA256}  viaproxy/ViaProxy.jar" | sha256sum -c -

COPY src ./src
COPY public ./public
RUN chown -R node /app
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node
CMD ["npm", "start"]
