FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web/language.js web/language.d.ts ./web/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY web ./web
COPY locales ./locales
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3210
CMD ["node", "dist/index.js"]
