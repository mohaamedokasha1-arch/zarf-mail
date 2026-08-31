# =============================================================
#  صورة Docker لخدمة ظرف (Zarf Mail)
#  البناء:  docker build -t zarf-mail .
#  التشغيل: docker run -p 3000:3000 -p 2525:2525 -v zarf-data:/app/data zarf-mail
# =============================================================
FROM node:20-alpine

# أدوات البناء اللازمة لحزم better-sqlite3 (إن لم تتوفر نسخة جاهزة)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# تثبيت الاعتماديات أولاً للاستفادة من الكاش
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# نسخ بقية المشروع
COPY . .

# مجلد البيانات (قاعدة SQLite) — يجب أن يكون Volume دائماً
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

EXPOSE 3000 2525

VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
