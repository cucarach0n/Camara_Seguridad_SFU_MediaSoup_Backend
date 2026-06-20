# Cámara MCU Backend - Mediasoup SFU

Este es el servidor de señalización y enrutamiento multimedia (SFU) construido con **NestJS** y **Mediasoup**.

## Características
- **Mediasoup:** Enrutamiento de video y audio RTP con soporte nativo de WebRTC.
- **Socket.io:** Señalización en tiempo real para el intercambio de parámetros de transporte.
- **Modos de Grabación:**
  - **Modo A:** Recibe *chunks* enviados desde el cliente (`MediaRecorder`) y los une en un archivo `.webm`.
  - **Modo B:** Consume flujos directamente desde Mediasoup mediante un `PlainTransport`, procesa con FFmpeg y guarda un `.mp4` con soporte H.264 y AAC de forma local.

## Requisitos previos
- Node.js v22+
- Python y herramientas de compilación C/C++ (requeridos para compilar Mediasoup).
- **FFmpeg** instalado en el servidor (solo necesario si vas a usar el Modo B).

## Instalación

```bash
$ npm install
```

> [!TIP]
> **Instalación en Oracle Cloud o servidores ARM (Ubuntu 20.04):**
> Si presentas fallos de compilación en ARM, asegúrate de actualizar tu compilador a GCC 10 e instalar usando permisos de administrador para evitar problemas de NPM:
> ```bash
> sudo apt install -y gcc-10 g++-10
> sudo update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-10 100
> sudo update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-10 100
> npm install --unsafe-perm
> ```

## Configuración
Renombra el archivo `.env.example` a `.env` y configura tu modo de grabación preferido:
```bash
cp .env.example .env
```

## Ejecutar el servidor

```bash
# modo watch (desarrollo, recomendado)
$ npm run start:dev

# producción
$ npm run build
$ npm run start:prod
```
