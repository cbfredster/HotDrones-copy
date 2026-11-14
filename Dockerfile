# HotDrones: API server + built app in one image.
#   docker build -t hotdrones .
#   docker run --env-file .env -p 8787:8787 hotdrones
FROM node:22-slim
WORKDIR /app

# Dependencies first, so they are cached between code changes. tsx (a dev dependency) runs
# the TypeScript server and experiment scripts directly, so dev dependencies stay installed.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production PORT=8787
EXPOSE 8787
# Scenarios (when MongoDB is not connected) and the speech cache live here.
VOLUME /app/data
CMD ["npx", "tsx", "server/index.ts"]
