FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web/language.js web/language.d.ts ./web/
RUN npm run build && npm prune --omit=dev && mkdir /app/data

FROM gcr.io/distroless/nodejs22-debian13:nonroot
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY web ./web
COPY locales ./locales
COPY --from=build --chown=65532:65532 /app/data ./data
USER 65532:65532
EXPOSE 3210
CMD ["dist/index.js"]
