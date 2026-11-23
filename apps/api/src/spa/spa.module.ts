import { Module, type DynamicModule } from '@nestjs/common';
import { SpaController, WEB_DIST_DIR } from './spa.controller.js';

@Module({})
export class SpaModule {
  static forRoot(webDistDir: string): DynamicModule {
    return { module: SpaModule, controllers: [SpaController], providers: [{ provide: WEB_DIST_DIR, useValue: webDistDir }] };
  }
}
