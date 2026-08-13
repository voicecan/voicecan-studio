FROM node:24.19.0-bookworm-slim AS build

WORKDIR /workspace
COPY package.json package-lock.json tsconfig.json ./
COPY vendor vendor
RUN npm ci --ignore-scripts

COPY src src
RUN npm run build

FROM node:24.19.0-bookworm-slim
ENV NODE_ENV=production
ARG FFMPEG_APT_VERSION=7:5.1.9-0+deb12u1
ARG LIBLC3_TOOLS_APT_VERSION=1.0.1-1+b1
COPY scripts/install-audio-tools.sh /tmp/install-audio-tools.sh
RUN FFMPEG_APT_VERSION="$FFMPEG_APT_VERSION" LIBLC3_TOOLS_APT_VERSION="$LIBLC3_TOOLS_APT_VERSION" bash /tmp/install-audio-tools.sh \
    && rm -f /tmp/install-audio-tools.sh \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /workspace /app
USER node
EXPOSE 8811
ENTRYPOINT ["node", "dist/main-external.js"]
