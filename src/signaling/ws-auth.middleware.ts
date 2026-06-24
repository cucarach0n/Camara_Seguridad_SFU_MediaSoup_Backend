import { Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { GatewaysDbService } from '../gateways-db/gateways-db.service';
import { Logger } from '@nestjs/common';

export const WsAuthMiddleware = (jwtService: JwtService, gatewaysDbService: GatewaysDbService) => {
  const logger = new Logger('WsAuthMiddleware');

  return async (client: Socket, next: (err?: Error) => void) => {
    try {
      // 1. Es un Gateway conectándose
      const gatewayId = client.handshake.auth?.gatewayId;
      if (gatewayId) {
        const gw = await gatewaysDbService.findByIdentificador(gatewayId);
        if (!gw) {
          logger.warn(`Gateway rechazado. Identificador no encontrado en BD: ${gatewayId}`);
          return next(new Error('Gateway no autorizado'));
        }
        client.data.isGateway = true;
        client.data.gatewayId = gatewayId;
        client.data.gatewayDbId = gw.id;
        client.data.gatewayUserId = gw.user_id;
        return next();
      }

      // 2. Es un Usuario (Navegador)
      const token = client.handshake.auth?.token;
      if (!token) {
        return next(new Error('Autenticación requerida'));
      }

      const payload = jwtService.verify(token);
      client.data.user = { id: payload.sub, username: payload.username, rol: payload.rol };
      next();
    } catch (err) {
      next(new Error('Token inválido o expirado'));
    }
  };
};
