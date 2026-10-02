FROM node:20 AS builder
ENV NODE_ENV=build

USER node
WORKDIR /home/node

COPY --chown=node:node . .
RUN npm ci
RUN npm run build

# -----

FROM node:20-slim

ENV NODE_ENV=production

USER node
WORKDIR /home/node

COPY --from=builder --chown=node:node /home/node/backend/dist/ ./
# native modules are kept out of the bundle (backend/tsup.config.ts)
RUN npm i --no-save --no-package-lock sharp@0.33 bufferutil@4

EXPOSE 8790
CMD ["node", "app"]
