import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

export interface JwtPayload {
  sub: number;
  username: string;
  rol: 'ADMIN' | 'USER';
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'fallback_secret_change_me'),
    });
  }

  async validate(payload: JwtPayload) {
    // El objeto retornado se adjunta a request.user en cada petición protegida
    return { id: payload.sub, username: payload.username, rol: payload.rol };
  }
}
