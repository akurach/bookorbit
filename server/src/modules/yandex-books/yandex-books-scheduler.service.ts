import { Injectable } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { SystemCron } from '../../common/decorators/system-cron.decorator';
import { YandexBooksSyncService } from './yandex-books-sync.service';

@Injectable()
export class YandexBooksSchedulerService {
  constructor(private readonly sync: YandexBooksSyncService) {}
  @SystemCron(CronExpression.EVERY_MINUTE)
  async runDue(): Promise<void> {
    await this.sync.pollDue();
  }
}
