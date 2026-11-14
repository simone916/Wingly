FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY web ./web
ENV WINGLY_DATA=/data PORT=8686
VOLUME /data
EXPOSE 8686
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
