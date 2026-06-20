import { types } from 'mediasoup';
require('dotenv').config();
export const config = {
  worker: {
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
  },
  router: {
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
          'level-asymmetry-allowed': 1,
          'x-google-start-bitrate': 1000,
        },
      },
    ] as types.RtpCodecCapability[],
  },
  webRtcTransport: {
    listenIps: [
      {
        ip: process.env.LISTEN_IP || '127.0.0.1',
        announcedIp: process.env.ANNOUNCED_IP || undefined,
      },
    ] as any[],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000,
  },
  plainTransport: {
    listenIp: { ip: '127.0.0.1' },
  }
};
