FROM node:22-alpine AS build
WORKDIR /app
RUN npm i -g npm@11.12.1
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p . --outDir dist --rootDir .

FROM node:22-alpine
WORKDIR /app
RUN npm i -g npm@11.12.1
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./dist/migrations
COPY public ./dist/public
RUN mkdir -p /app/uploads && chown node:node /app/uploads
VOLUME /app/uploads
USER node
EXPOSE 4000
# the server applies pending migrations itself at startup (AUTO_MIGRATE=0 to disable)
CMD ["node", "dist/src/server.js"]
