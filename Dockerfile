FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
RUN chown node /app
USER node
CMD ["npm", "start"]
