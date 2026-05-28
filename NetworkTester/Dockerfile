FROM node:lts-alpine

WORKDIR /app

# Install build dependencies required for native modules (sqlite3, lzma-native)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    gcc \
    libc-dev

COPY package.json ./
RUN npm install

COPY index.js ./

CMD ["npm", "start"]