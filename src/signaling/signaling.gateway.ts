import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MediasoupService } from '../mediasoup/mediasoup.service';
import { RecordingService } from '../recording/recording.service';
import { types } from 'mediasoup';
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@WebSocketGateway({ cors: true })
export class SignalingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private logger = new Logger(SignalingGateway.name);

  // Mappings to track state per peer
  private transports: Map<string, types.Transport> = new Map();
  private producers: Map<string, types.Producer> = new Map();
  private consumers: Map<string, types.Consumer> = new Map();
  private streamerSocketId: string | null = null;

  // RTSP Gateways state
  private gateways: Map<string, { gatewayId: string; cameras: Array<{ id: string; name: string; rtspUrl: string }> }> = new Map();
  private rtspStreams: Map<string, {
    videoTransport: types.PlainTransport;
    audioTransport: types.PlainTransport | null;
    videoProducer: types.Producer;
    audioProducer: types.Producer | null;
  }> = new Map();
  private cameraViewers: Map<string, Set<string>> = new Map();

  constructor(
    private mediasoupService: MediasoupService,
    private recordingService: RecordingService
  ) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    const recordingMode = process.env.RECORDING_MODE || 'A';
    client.emit('config-mode', recordingMode);

    // Enviar lista actualizada de cámaras al conectar
    const list = this.getRtspCamerasList();
    client.emit('rtsp-cameras-updated', list);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.chunkFiles.delete(client.id);

    // Si el cliente desconectado es un gateway
    const gw = this.gateways.get(client.id);
    if (gw) {
      this.logger.warn(`Gateway desconectado: ${gw.gatewayId}`);
      for (const cam of gw.cameras) {
        if (this.rtspStreams.has(cam.id)) {
          this.stopRtspStream(cam.id);
        }
      }
      this.gateways.delete(client.id);
      this.broadcastCameras();
    }

    // Si el cliente desconectado era espectador de alguna cámara IP
    for (const [cameraId, viewers] of this.cameraViewers.entries()) {
      if (viewers.has(client.id)) {
        this.removeViewerFromCamera(client.id, cameraId);
      }
    }

    // Clean up streamer
    if (this.streamerSocketId === client.id) {
      this.streamerSocketId = null;
      this.server.emit('streamer-disconnected');
      
      const recordingMode = process.env.RECORDING_MODE || 'A';
      if (recordingMode === 'B') {
        this.recordingService.stopRecording(client.id);
      }
    }
    const transportsToClose = [...this.transports.entries()].filter(([id]) => id.startsWith(client.id));
    for (const [id, transport] of transportsToClose) {
      transport.close();
      this.transports.delete(id);
    }
  }

  @SubscribeMessage('getRouterRtpCapabilities')
  handleGetRouterRtpCapabilities() {
    return this.mediasoupService.getRouterRtpCapabilities();
  }

  @SubscribeMessage('createWebRtcTransport')
  async handleCreateTransport(@ConnectedSocket() client: Socket) {
    const transport = await this.mediasoupService.createWebRtcTransport();
    this.transports.set(`${client.id}_${transport.id}`, transport);

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  @SubscribeMessage('connectTransport')
  async handleConnectTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { transportId: string; dtlsParameters: any },
  ) {
    const transport = this.transports.get(`${client.id}_${data.transportId}`);
    if (!transport) throw new Error('Transport not found');
    await transport.connect({ dtlsParameters: data.dtlsParameters });
    return true;
  }

  @SubscribeMessage('produce')
  async handleProduce(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { transportId: string; kind: 'audio'|'video'; rtpParameters: any },
  ) {
    const transport = this.transports.get(`${client.id}_${data.transportId}`);
    if (!transport) throw new Error('Transport not found');
    
    const producer = await transport.produce({
      kind: data.kind,
      rtpParameters: data.rtpParameters,
      appData: { socketId: client.id }
    });
    
    this.producers.set(producer.id, producer);

    producer.on('transportclose', () => {
      this.producers.delete(producer.id);
    });
    
    if (data.kind === 'video') {
      this.streamerSocketId = client.id;
      client.broadcast.emit('new-producer', producer.id);
    }

    return { id: producer.id };
  }

  @SubscribeMessage('consume')
  async handleConsume(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { producerId: string; rtpCapabilities: any },
  ) {
    const router = this.mediasoupService.getRouter();
    if (!router.canConsume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities })) {
      throw new Error('Cannot consume');
    }

    const transportEntry = [...this.transports.entries()].find(([id]) => id.startsWith(client.id));
    if (!transportEntry) throw new Error('Transport not found');
    const transport = transportEntry[1];

    const producer = this.producers.get(data.producerId);
    if (!producer) throw new Error('Producer not found');

    const consumer = await transport.consume({
      producerId: data.producerId,
      rtpCapabilities: data.rtpCapabilities,
      paused: true,
      appData: producer.appData,
    });

    this.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => {
      this.consumers.delete(consumer.id);
    });

    consumer.on('producerclose', () => {
      this.consumers.delete(consumer.id);
      client.emit('producer-closed', { consumerId: consumer.id });
    });

    return {
      id: consumer.id,
      producerId: data.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      appData: consumer.appData,
    };
  }

  @SubscribeMessage('resume')
  async handleResume(@MessageBody() data: { consumerId: string }) {
    const consumer = this.consumers.get(data.consumerId);
    if (!consumer) throw new Error('Consumer not found');
    await consumer.resume();
    return true;
  }

  // --- MODO A: Chunk recording ---
  private chunkFiles: Map<string, { path: string; startTime: number }> = new Map();

  @SubscribeMessage('video-chunk')
  handleVideoChunk(@ConnectedSocket() client: Socket, @MessageBody() data: ArrayBuffer) {
    const recordingMode = process.env.RECORDING_MODE || 'A';
    if (recordingMode === 'A') {
      const now = Date.now();
      let fileInfo = this.chunkFiles.get(client.id);

      // Si no existe o han pasado más de 15 minutos (900000 ms)
      if (!fileInfo || (now - fileInfo.startTime) > 15 * 60 * 1000) {
        const dateStr = new Date().toISOString().split('T')[0];
        const dirPath = path.join(__dirname, '..', '..', 'recordings', dateStr);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
        
        const timeStr = new Date().toISOString().split('T')[1].replace(/:/g, '-').split('.')[0];
        const fileName = path.join(dirPath, `recording-${client.id}-${dateStr}_${timeStr}.webm`);
        
        fileInfo = { path: fileName, startTime: now };
        this.chunkFiles.set(client.id, fileInfo);
        this.logger.log(`Nuevo segmento de WebM creado: ${fileName}`);
      }

      fs.appendFileSync(fileInfo.path, Buffer.from(data));
    }
  }

  @SubscribeMessage('getStreamerId')
  handleGetStreamerId() {
    // Retorna los producer IDs disponibles
    return [...this.producers.keys()];
  }

  @SubscribeMessage('start-recording')
  async handleStartRecording(@ConnectedSocket() client: Socket) {
    const recordingMode = process.env.RECORDING_MODE || 'A';
    if (recordingMode === 'B') {
      const myProducers = [...this.producers.values()].filter(p => p.appData.socketId === client.id);
      this.recordingService.startRecording(myProducers, client.id);
    }
  }

  // --- MÉTODOS DE INTEGRACIÓN RTSP GATEWAY ---

  @SubscribeMessage('register-gateway')
  handleRegisterGateway(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gatewayId: string; cameras: Array<{ id: string; name: string; rtspUrl: string }> }
  ) {
    this.logger.log(`Gateway de medios local registrado: ${data.gatewayId} (${client.id})`);
    this.gateways.set(client.id, { gatewayId: data.gatewayId, cameras: data.cameras });
    this.broadcastCameras();
    return true;
  }

  @SubscribeMessage('get-rtsp-cameras')
  handleGetRtspCameras() {
    return this.getRtspCamerasList();
  }

  @SubscribeMessage('request-camera-stream')
  async handleRequestCameraStream(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { cameraId: string }
  ) {
    const { cameraId } = data;
    this.logger.log(`Viewer ${client.id} solicita cámara: ${cameraId}`);

    let viewers = this.cameraViewers.get(cameraId);
    if (!viewers) {
      viewers = new Set();
      this.cameraViewers.set(cameraId, viewers);
    }
    viewers.add(client.id);

    // Si el stream ya está activo, retornar los IDs de productor existentes
    const activeStream = this.rtspStreams.get(cameraId);
    if (activeStream) {
      return {
        videoProducerId: activeStream.videoProducer.id,
        audioProducerId: activeStream.audioProducer ? activeStream.audioProducer.id : null
      };
    }

    // Si no está activo, buscar la cámara y su respectivo gateway
    let targetCamera: { id: string; name: string; rtspUrl: string } | null = null;
    let gatewaySocketId: string | null = null;

    for (const [socketId, gw] of this.gateways.entries()) {
      const cam = gw.cameras.find(c => c.id === cameraId);
      if (cam) {
        targetCamera = cam;
        gatewaySocketId = socketId;
        break;
      }
    }

    if (!targetCamera || !gatewaySocketId) {
      throw new Error(`Cámara ${cameraId} o Gateway no encontrados`);
    }

    // 1. Crear PlainTransports de MediaSoup con comedia: true para el ingreso de paquetes RTP
    const videoTransport = await this.mediasoupService.createPlainTransport({ comedia: true });
    const audioTransport = await this.mediasoupService.createPlainTransport({ comedia: true });

    this.transports.set(`gateway_video_${videoTransport.id}`, videoTransport);
    this.transports.set(`gateway_audio_${audioTransport.id}`, audioTransport);

    // 2. Notificar al gateway local para iniciar el streaming RTP vía FFmpeg y esperar confirmación
    const listenIp = process.env.LISTEN_IP || '127.0.0.1';
    this.logger.log(`Emitiendo start-rtsp-stream a gateway para cámara: ${cameraId}`);

    const gatewayResponse = await new Promise<{ hasAudio: boolean } | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.logger.warn(`Timeout esperando respuesta del gateway local para cámara: ${cameraId}`);
        resolve(null);
      }, 10000);

      const gatewaySocket = this.server.sockets.sockets.get(gatewaySocketId);
      if (!gatewaySocket) {
        this.logger.error(`Gateway socket ${gatewaySocketId} no encontrado al intentar emitir start-rtsp-stream`);
        clearTimeout(timeout);
        resolve(null);
        return;
      }

      gatewaySocket.emit('start-rtsp-stream', {
        cameraId,
        rtspUrl: targetCamera.rtspUrl,
        videoPort: videoTransport.tuple.localPort,
        audioPort: audioTransport.tuple.localPort,
        backendIp: listenIp
      }, (ack: any) => {
        clearTimeout(timeout);
        this.logger.log(`Respuesta DIRECTA del gateway local para ${cameraId}: ${JSON.stringify(ack)}`);
        resolve(ack);
      });
    });

    const hasAudio = gatewayResponse ? gatewayResponse.hasAudio : false;

    // 3. Crear los productores en MediaSoup con codecs correspondientes
    const videoProducer = await videoTransport.produce({
      kind: 'video',
      rtpParameters: {
        codecs: [
          {
            mimeType: 'video/H264',
            payloadType: 101,
            clockRate: 90000,
            parameters: {
              'packetization-mode': 1,
              'profile-level-id': '42e01f',
              'level-asymmetry-allowed': 1
            }
          }
        ],
        encodings: [{ ssrc: 11111 }]
      },
      appData: { cameraId }
    });
    this.producers.set(videoProducer.id, videoProducer);

    let audioProducer: types.Producer | null = null;
    if (hasAudio) {
      audioProducer = await audioTransport.produce({
        kind: 'audio',
        rtpParameters: {
          codecs: [
            {
              mimeType: 'audio/opus',
              payloadType: 102,
              clockRate: 48000,
              channels: 2
            }
          ],
          encodings: [{ ssrc: 22222 }]
        },
        appData: { cameraId }
      });
      this.producers.set(audioProducer.id, audioProducer);
    } else {
      // Si la cámara no tiene audio, cerramos el PlainTransport de audio
      audioTransport.close();
      this.transports.delete(`gateway_audio_${audioTransport.id}`);
    }

    const activeProducers: types.Producer[] = [videoProducer];
    if (audioProducer) {
      activeProducers.push(audioProducer);
    }

    this.rtspStreams.set(cameraId, {
      videoTransport,
      audioTransport: hasAudio ? audioTransport : null,
      videoProducer,
      audioProducer
    });

    // Iniciar grabación del servidor (Modo B) para esta cámara RTSP
    const recordingMode = process.env.RECORDING_MODE || 'A';
    if (recordingMode === 'B') {
      this.recordingService.startRecording(activeProducers, `rtsp-${cameraId}`);
    }

    // Notificar estado a todos
    this.broadcastCameras();

    // Broadcast a los clientes de que hay nuevos productores disponibles para consumir
    this.server.emit('new-producer', videoProducer.id);
    if (audioProducer) {
      this.server.emit('new-producer', audioProducer.id);
    }

    return {
      videoProducerId: videoProducer.id,
      audioProducerId: audioProducer ? audioProducer.id : null
    };
  }

  @SubscribeMessage('leave-camera-stream')
  handleLeaveCameraStream(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { cameraId: string }
  ) {
    const { cameraId } = data;
    this.removeViewerFromCamera(client.id, cameraId);
    return true;
  }

  private removeViewerFromCamera(socketId: string, cameraId: string) {
    const viewers = this.cameraViewers.get(cameraId);
    if (viewers) {
      viewers.delete(socketId);
      if (viewers.size === 0) {
        this.cameraViewers.delete(cameraId);
        this.stopRtspStream(cameraId);
      }
    }
  }

  private async stopRtspStream(cameraId: string) {
    const stream = this.rtspStreams.get(cameraId);
    if (stream) {
      this.logger.log(`Deteniendo stream RTSP de cámara: ${cameraId}`);

      // Detener grabación del servidor si está activa
      const recordingMode = process.env.RECORDING_MODE || 'A';
      if (recordingMode === 'B') {
        this.recordingService.stopRecording(`rtsp-${cameraId}`);
      }

      // Notificar al gateway para apagar el FFmpeg
      const gatewayEntry = [...this.gateways.entries()].find(([_, gw]) => gw.cameras.some(c => c.id === cameraId));
      if (gatewayEntry) {
        const [gatewaySocketId] = gatewayEntry;
        this.server.to(gatewaySocketId).emit('stop-rtsp-stream', { cameraId });
      }

      // Cerrar productores
      this.producers.delete(stream.videoProducer.id);
      stream.videoProducer.close();
      
      if (stream.audioProducer) {
        this.producers.delete(stream.audioProducer.id);
        stream.audioProducer.close();
      }

      // Cerrar transportes y remover del map para evitar fugas de memoria
      stream.videoTransport.close();
      this.transports.delete(`gateway_video_${stream.videoTransport.id}`);
      
      if (stream.audioTransport) {
        stream.audioTransport.close();
        this.transports.delete(`gateway_audio_${stream.audioTransport.id}`);
      }

      this.rtspStreams.delete(cameraId);
      this.broadcastCameras();
    }
  }

  private getRtspCamerasList() {
    const list: Array<{ id: string; name: string; isLive: boolean }> = [];
    for (const [_, gw] of this.gateways) {
      for (const cam of gw.cameras) {
        list.push({
          id: cam.id,
          name: cam.name,
          isLive: this.rtspStreams.has(cam.id)
        });
      }
    }
    return list;
  }

  private broadcastCameras() {
    const list = this.getRtspCamerasList();
    this.server.emit('rtsp-cameras-updated', list);
  }
}

