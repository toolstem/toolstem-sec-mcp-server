# This file intentionally only delegates to the root Dockerfile.
# Apify's actor.json -> dockerContextDir: ".." causes the parent
# directory to be the build context, with this file as the dockerfile.
# But we keep the real instructions in the root so local `docker build .`
# also works. Re-include the same multistage build here.

FROM apify/actor-node:22 AS builder

COPY package*.json ./

RUN npm install --include=dev --audit=false

COPY . ./

RUN npm run build

FROM apify/actor-node:22

COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

COPY --from=builder /usr/src/app/dist ./dist

COPY . ./

CMD ["node", "dist/actor.js"]
