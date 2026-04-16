FROM node:22-slim AS base
RUN npm install -g pnpm@9.15.4
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/control-plane/package.json ./packages/control-plane/
RUN pnpm install --frozen-lockfile --filter @orchestrator/control-plane...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/control-plane ./packages/control-plane
RUN pnpm --filter @orchestrator/shared build
RUN pnpm --filter @orchestrator/control-plane build

FROM node:22-slim AS runner
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/control-plane/dist ./packages/control-plane/dist
COPY --from=build /app/packages/control-plane/package.json ./packages/control-plane/package.json

ENV NODE_ENV=production
EXPOSE 3001 3002
CMD ["node", "packages/control-plane/dist/index.js"]
