FROM node:24-alpine AS workspace
WORKDIR /app
RUN npm install --global pnpm@12.15.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/front/package.json apps/front/
COPY apps/job-runner/package.json apps/job-runner/
COPY apps/receipt/package.json apps/receipt/
COPY packages/contracts/package.json packages/contracts/
COPY packages/eslint/package.json packages/eslint/
COPY packages/infra/package.json packages/infra/
COPY packages/tsconfig/package.json packages/tsconfig/
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
COPY scripts scripts
RUN pnpm build

FROM workspace AS server
ENV NODE_ENV=production
RUN mkdir /app/coverage-v8 && chown node:node /app/coverage-v8
USER node
CMD ["node", "apps/api/dist/main.js"]

FROM caddy:2-alpine AS front
COPY --from=workspace /app/apps/front/dist /srv
COPY apps/front/Caddyfile /etc/caddy/Caddyfile
