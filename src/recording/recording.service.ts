import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { MediasoupService } from '../mediasoup/mediasoup.service';
import { types } from 'mediasoup';
const ffmpeg = require('fluent-ffmpeg');
import * as fs from 'fs';
import * as path from 'path';
import { GrabacionesService } from '../grabaciones/grabaciones.service';
import { TransmisionesService } from '../transmisiones/transmisiones.service';

@Injectable()
export class RecordingService implements OnModuleDestroy {
  private readonly logger = new Logger(RecordingService.name);
  private recordTransports: Map<string, types.PlainTransport[]> = new Map();
  private recordConsumers: Map<string, types.Consumer[]> = new Map();
  private ffmpegProcesses: Map<string, any> = new Map();
  private stopResolvers: Map<string, () => void> = new Map();
  private recordPorts: Map<string, number[]> = new Map();

  constructor(
    private mediasoupService: MediasoupService,
    private grabacionesService: GrabacionesService,
    private transmisionesService: TransmisionesService
  ) {}

  private portCounter = 20000;

  getFreePort() {
    this.portCounter += 2;
    return this.portCounter;
  }

  async startRecording(producers: types.Producer[], streamerId: string, transmisionId?: number, userId?: number) {
    if (producers.length === 0) return;

    if (transmisionId) {
      const t = await this.transmisionesService.findById(transmisionId);
      if (t.grabacion_activa === 0) {
        this.logger.log(`Grabación deshabilitada (DVR OFF) para la transmisión ${transmisionId}`);
        return;
      }
    }

    this.logger.log(`Iniciando grabación para ${streamerId} con ${producers.length} productores: ${producers.map(p => p.kind).join(', ')}`);

    const router = this.mediasoupService.getRouter();

    // Clean up existing recording if any
    await this.stopRecording(streamerId);
    let sdpLines = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=FFmpeg',
      'c=IN IP4 127.0.0.1',
      't=0 0'
    ];

    const transports: types.PlainTransport[] = [];
    const consumers: types.Consumer[] = [];
    const ports: number[] = [];

    for (const producer of producers) {
      const plainTransport = await this.mediasoupService.createPlainTransport();
      transports.push(plainTransport);

      const ffmpegPort = this.getFreePort();
      ports.push(ffmpegPort);

      // Mediasoup enviará el flujo RTP a este puerto (donde FFmpeg escuchará)
      await plainTransport.connect({
        ip: '127.0.0.1',
        port: ffmpegPort,
        rtcpPort: ffmpegPort + 1
      });

      const consumer = await plainTransport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities, // consume with router's full capabilities
        paused: true
      });
      consumers.push(consumer);

      const rtpParameters = consumer.rtpParameters;
      const pt = rtpParameters.codecs[0].payloadType;
      const codecName = rtpParameters.codecs[0].mimeType.split('/')[1];
      const clockRate = rtpParameters.codecs[0].clockRate;
      const channels = rtpParameters.codecs[0].channels || 1;

      sdpLines.push(`m=${producer.kind} ${ffmpegPort} RTP/AVP ${pt}`);
      if (producer.kind === 'audio') {
        sdpLines.push(`a=rtpmap:${pt} ${codecName}/${clockRate}/${channels}`);
      } else {
        sdpLines.push(`a=rtpmap:${pt} ${codecName}/${clockRate}`);
        // a=framerate es CRUCIAL: sin él, FFmpeg interpreta el clockRate de 90kHz
        // como 90,000 fps en lugar de 30fps, causando burst de paquetes y video congelado.
        sdpLines.push('a=framerate:30');
        const fmtpParams: string[] = [];
        for (const [key, value] of Object.entries(rtpParameters.codecs[0].parameters || {})) {
          fmtpParams.push(`${key}=${value}`);
        }
        if (fmtpParams.length > 0) {
          sdpLines.push(`a=fmtp:${pt} ${fmtpParams.join(';')}`);
        }
      }

      await consumer.resume();
    }

    this.recordTransports.set(streamerId, transports);
    this.recordConsumers.set(streamerId, consumers);
    this.recordPorts.set(streamerId, ports);

    const sdpString = sdpLines.join('\n');
    const sdpPath = path.join(__dirname, '..', '..', `stream-${streamerId}.sdp`);
    fs.writeFileSync(sdpPath, sdpString);

    const dateStr = new Date().toISOString().split('T')[0];
    const dirPath = path.join(__dirname, '..', '..', 'recordings', dateStr);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    // El nombre incluye los IDs para que DvrUploaderService sepa a quién asignarlo
    const tId = transmisionId || 'NA';
    const uId = userId || 'NA';
    const fileNameFormat = `rec__${streamerId}__${tId}__${uId}__%Y%m%d_%H%M%S.mp4`;
    const outputPath = path.join(dirPath, fileNameFormat);

    const process = ffmpeg(sdpPath)
      .inputOptions([
        '-protocol_whitelist', 'file,rtp,udp',
        '-rw_timeout', '5000000',
        '-analyzeduration', '5000000',
        '-probesize', '5000000'
      ])
      .outputOptions([
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-strict', 'experimental',
        '-f', 'segment',
        '-segment_time', '900', // 15 minutos en segundos
        '-segment_format', 'mp4',
        '-reset_timestamps', '1',
        '-strftime', '1',
        '-movflags', 'frag_keyframe+empty_moov',
        '-y'
      ])
      .on('start', (cmd) => this.logger.log(`FFmpeg started: ${cmd}`))
      .on('stderr', (stderrLine) => this.logger.debug(`FFmpeg stderr: ${stderrLine}`))
      .on('error', async (err) => {
        this.logger.error(`FFmpeg error: ${err.message}`);
        await this.finalizeRecording(streamerId, dirPath);
      })
      .on('end', async () => {
        this.logger.log(`Grabación finalizada para streamer ${streamerId}`);
        await this.finalizeRecording(streamerId, dirPath);
      });

    process.save(outputPath);
    this.ffmpegProcesses.set(streamerId, process);

    // FIX: FFmpeg takes a few milliseconds to start and bind the UDP ports.
    // If Mediasoup sends the initial keyframe before FFmpeg is listening, it gets lost,
    // and FFmpeg drops the stream because it can't find the resolution.
    // We wait 1.5 seconds to ensure FFmpeg is listening, then request a fresh keyframe.
    setTimeout(async () => {
      for (const consumer of consumers) {
        if (consumer.kind === 'video') {
          try {
            await consumer.requestKeyFrame();
            this.logger.log(`Keyframe requested for video consumer ${consumer.id}`);
            
            // Check if Mediasoup is actually receiving video from the browser
            const producer = producers.find(p => p.id === consumer.producerId);
            if (producer) {
              const stats = await producer.getStats();
              this.logger.debug(`Stats de red del cliente: ${JSON.stringify(stats)}`);
            }
          } catch (e) {
            this.logger.error(`Failed to request keyframe: ${e}`);
          }
        }
      }
    }, 1500);
  }

  async stopRecording(streamerId: string): Promise<void> {
    const process = this.ffmpegProcesses.get(streamerId);
    let stopPromise = Promise.resolve();

    if (process) {
      stopPromise = new Promise<void>((resolve) => {
        this.stopResolvers.set(streamerId, resolve);
      });

      if (process.ffmpegProc && process.ffmpegProc.stdin) {
        process.ffmpegProc.stdin.write('q\n');

        // Send a dummy UDP packet to unblock FFmpeg on Windows so it can process 'q'
        const dgram = require('dgram');
        const dummyClient = dgram.createSocket('udp4');
        const ports = this.recordPorts.get(streamerId) || [];
        for (const port of ports) {
          dummyClient.send(Buffer.from([0x00]), port, '127.0.0.1', () => {});
        }
        setTimeout(() => dummyClient.close(), 100);

      } else {
        process.kill('SIGINT');
      }
      this.ffmpegProcesses.delete(streamerId);
      this.recordPorts.delete(streamerId);
    }
    
    // Close consumers and transports FIRST so Mediasoup sends RTCP BYE to FFmpeg
    // This allows FFmpeg to gracefully end the stream, even on Windows
    const consumers = this.recordConsumers.get(streamerId) || [];
    for (const consumer of consumers) {
      consumer.close();
    }
    this.recordConsumers.delete(streamerId);

    const transports = this.recordTransports.get(streamerId) || [];
    for (const transport of transports) {
      transport.close();
    }
    this.recordTransports.delete(streamerId);

    // Esperar a que FFmpeg termine de escribir el archivo
    try {
      await stopPromise;
    } catch (e) {
      this.logger.error(`Error esperando a que ffmpeg termine: ${e.message}`);
    }
  }

  onModuleDestroy() {
    this.logger.log('Cerrando procesos FFmpeg y transportes de grabación al detener el módulo...');
    for (const streamerId of this.ffmpegProcesses.keys()) {
      this.stopRecording(streamerId);
    }
  }

  private async finalizeRecording(streamerId: string, dirPath: string) {
    const sdpPath = path.join(__dirname, '..', '..', `stream-${streamerId}.sdp`);
    if (fs.existsSync(sdpPath)) {
      try { fs.unlinkSync(sdpPath); } catch (e) {}
    }

    // La base de datos ya no se actualiza aquí porque DvrUploaderService 
    // se encarga de escanear los archivos y registrar TODOS los fragmentos.

    const resolve = this.stopResolvers.get(streamerId);
    if (resolve) {
      resolve();
      this.stopResolvers.delete(streamerId);
    }
  }
}
