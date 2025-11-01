FROM node:22-bullseye-slim
WORKDIR /app

# Install chromium deps
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates fonts-liberation wget libasound2 libatk1.0-0 libatk-bridge2.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 \
  libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
  libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
  libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
  lsb-release xdg-utils && rm -rf /var/lib/apt/lists/*

# Create unprivileged user
RUN groupadd -r app && useradd -r -g app -m -d /home/app app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN chown -R app:app /app
USER app
EXPOSE 8080
CMD ["node", "server.js"]
