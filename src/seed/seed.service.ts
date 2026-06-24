import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { Usuario } from '../usuarios/entities/usuario.entity';

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @InjectRepository(Usuario)
    private usuariosRepo: Repository<Usuario>,
  ) {}

  async onApplicationBootstrap() {
    await this.seedAdmin();
  }

  private async seedAdmin() {
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';

    const existing = await this.usuariosRepo.findOne({
      where: { rol: 'ADMIN' },
    });

    if (existing) {
      this.logger.log(`Usuario ADMIN ya existe: '${existing.username}'. Seed omitido.`);
      return;
    }

    const password_hash = await bcrypt.hash(adminPassword, 10);
    const admin = this.usuariosRepo.create({
      username: adminUsername,
      password_hash,
      rol: 'ADMIN',
      activo: 1,
    });
    await this.usuariosRepo.save(admin);
    this.logger.log(`✅ Usuario ADMIN creado: '${adminUsername}'. Cambia la contraseña en producción.`);
  }
}
