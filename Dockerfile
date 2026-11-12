# VEYRA application image (Phase 14 Part 4): one image, one process per container.
#   API:      node apps/api/dist/main.js
#   Worker:   node apps/worker/dist/main.js
#   Console:  node node_modules/next/dist/bin/next start apps/console-web -p 3000
#   Migrate:  node node_modules/prisma/build/index.js migrate deploy (in packages/db, as the owner)
# The console's public addresses are baked in at build time (Next.js inlines NEXT_PUBLIC_*).

FROM oven/bun:1.4.4 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1
COPY . .
RUN bun install --frozen-lockfile
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api/v1
ARG NEXT_PUBLIC_STORAGE_ORIGIN=http://localhost:8333
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    NEXT_PUBLIC_STORAGE_ORIGIN=${NEXT_PUBLIC_STORAGE_ORIGIN} \
    NODE_ENV=production
RUN bun run db:generate \
 && bunx turbo run build --filter=@veyra/api --filter=@veyra/worker --filter=@veyra/console-web

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app /app
# Never run as root.
USER node
EXPOSE 3000 4000 4001
CMD ["node", "apps/api/dist/main.js"]
