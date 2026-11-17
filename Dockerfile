# Es la misma imagen que oven/bun:1-alpine -mismo digest- pero servida por el
# cache publico de Google en vez de Docker Hub.
#
# Docker Hub limita las descargas anonimas por IP, y la IP del builder de Zeabur
# la comparten muchos proyectos: el pull empezo a devolver 429 y despues a
# colgarse reintentando, con el deploy en "Building" por 20 minutos sin que el
# codigo tuviera nada que ver. mirror.gcr.io no tiene ese limite.
FROM mirror.gcr.io/oven/bun:1-alpine

WORKDIR /app

# openssl es obligatorio: sin el, Prisma no puede detectar la version de OpenSSL
# al generar el cliente, asume 1.1 por defecto y baja el motor equivocado. En
# tiempo de ejecucion falla con "libssl.so.1.1: No such file or directory",
# porque Alpine moderno trae OpenSSL 3.
RUN apk update && apk add --no-cache bash openssl

# El lockfile va antes del codigo para que Docker reuse la capa de dependencias
# mientras solo cambie el codigo. --frozen-lockfile obliga a instalar las
# versiones exactas del lock, para que el build sea reproducible.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Prisma va ANTES del codigo, y no despues.
#
# `prisma generate` baja los motores de la base (decenas de MB) y es el paso mas
# lento del build. Puesto despues de COPY . ., cualquier cambio de una linea de
# codigo invalidaba su capa y lo hacia correr de nuevo entero. Copiando solo el
# schema, la capa se reusa mientras el schema no cambie: un deploy que solo toca
# codigo se saltea la descarga.
#
# El cliente generado vive en node_modules/, que el .dockerignore deja fuera del
# contexto, asi que el COPY . . de abajo no lo pisa.
COPY prisma ./prisma
RUN bunx prisma generate

COPY . .

EXPOSE 8080
CMD ["bun", "run", "start"]
