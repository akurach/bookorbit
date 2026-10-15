import { Module } from '@nestjs/common';
import { BookModule } from '../book/book.module';
import { UserModule } from '../user/user.module';
import { LibraryModule } from '../library/library.module';
import { YandexBooksController } from './yandex-books.controller';
import { YandexBooksClientService } from './yandex-books-client.service';
import { YandexBooksCredentialService } from './yandex-books-credential.service';
import { YandexBooksRepository } from './yandex-books.repository';
import { YandexBooksSchedulerService } from './yandex-books-scheduler.service';
import { YandexBooksSettingsService } from './yandex-books-settings.service';
import { YandexBooksSyncService } from './yandex-books-sync.service';

@Module({
  imports: [BookModule, UserModule, LibraryModule],
  controllers: [YandexBooksController],
  providers: [
    YandexBooksClientService,
    YandexBooksCredentialService,
    YandexBooksRepository,
    YandexBooksSettingsService,
    YandexBooksSyncService,
    YandexBooksSchedulerService,
  ],
  exports: [YandexBooksSettingsService, YandexBooksSyncService],
})
export class YandexBooksModule {}
