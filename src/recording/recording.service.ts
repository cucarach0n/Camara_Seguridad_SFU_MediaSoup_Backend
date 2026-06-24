import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { MediasoupService } from '../mediasoup/mediasoup.service';
import { types } from 'mediasoup';
const ffmpeg = require('fluent-ffmpeg');
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class RecordingService implements OnModuleDestroy {
  private readonly logger = new Logger(RecordingService.name);
  private recordTransports: Map<string, types.PlainTransport[]> = new Map();
  private recordConsumers: Map<string, types.Consumer[]> = new Map();
  private ffmpegProcesses: Map<string, any> = new Map();

  constructor(private mediasoupService: MediasoupService) {}

  private portCounter = 20000;

  getFreePort() {
    this.portCounter += 2;
    return this.portCounter;
  }

  async startRecording(producers: types.Producer[], streamerId: string) {
    if (producers.length === 0) return;

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

    for (const producer of producers) {
      const plainTransport = await this.mediasoupService.createPlainTransport();
      transports.push(plainTransport);

      const ffmpegPort = this.getFreePort();

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

    const sdpString = sdpLines.join('\n');
    const sdpPath = path.join(__dirname, '..', '..', `stream-${streamerId}.sdp`);
    fs.writeFileSync(sdpPath, sdpString);

    const dateStr = new Date().toISOString().split('T')[0];
    const dirPath = path.join(__dirname, '..', '..', 'recordings', dateStr);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    const outputPath = path.join(dirPath, `server-recording-${streamerId}-%Y-%m-%d_%H-%M-%S.mp4`);

    const process = ffmpeg(sdpPath)
      .inputOptions([
        '-protocol_whitelist', 'file,rtp,udp',
        // use_wallclock_as_timestamps: usa el reloj de pared real en lugar de los
        // timestamps RTP del stream. Esto soluciona tres problemas a la vez:
        //   1. Elimina el timestamp inicial negativo (time=-577014h) causado por el
        //      offset del reloj RTP de la cámara/browser desde que encendió.
        //   2. Elimina el burst inicial (speed=4.4x) porque los paquetes se procesan
        //      en tiempo real según el reloj del servidor, no del RTP.
        //   3. Elimina el warning "Timestamps are unset in a packet".
        '-use_wallclock_as_timestamps', '1',
        // Para redes WAN el gateway puede enviar paquetes con jitter alto.
        '-max_delay', '5000000',
        '-reorder_queue_size', '0',
        // 5s es suficiente; el codec ya está declarado en el SDP.
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
        // frag_keyframe: permite reproducción mientras se graba
        // empty_moov: metadata al inicio del fragmento (streaming-friendly)
        '-movflags', 'frag_keyframe+empty_moov',
        '-y'
      ])
      .on('start', (cmd) => this.logger.log(`FFmpeg started: ${cmd}`))
      .on('stderr', (stderrLine) => this.logger.debug(`FFmpeg stderr: ${stderrLine}`))
      .on('error', (err) => this.logger.error(`FFmpeg error: ${err.message}`))
      .on('end', () => {
        this.logger.log(`Grabación finalizada: ${outputPath}`);
        if (fs.existsSync(sdpPath)) fs.unlinkSync(sdpPath);
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

  stopRecording(streamerId: string) {
    const process = this.ffmpegProcesses.get(streamerId);
    if (process) {
      if (process.ffmpegProc && process.ffmpegProc.stdin) {
        process.ffmpegProc.stdin.write('q\n');
      } else {
        process.kill('SIGINT');
      }
      this.ffmpegProcesses.delete(streamerId);
    }
    
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
  }

  onModuleDestroy() {
    this.logger.log('Cerrando procesos FFmpeg y transportes de grabación al detener el módulo...');
    for (const streamerId of this.ffmpegProcesses.keys()) {
      this.stopRecording(streamerId);
    }
  }
}
