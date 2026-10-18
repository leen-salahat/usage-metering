FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src

ENV METERING_URL=http://service:3000
USER node
CMD ["npm", "run", "demo"]
