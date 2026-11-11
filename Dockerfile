# デジプル勤怠（Railway）
# 帳票の計算・PDF化に LibreOffice（Calc）と日本語フォントを使う
FROM node:22-bookworm-slim

ENV TZ=Asia/Tokyo \
    NODE_ENV=production \
    SOFFICE_PATH=/usr/bin/soffice \
    HOME=/tmp

RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-calc-nogui fonts-noto-cjk tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY core ./core
COPY server ./server
COPY public ./public
COPY template ./template

USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
