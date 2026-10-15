import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Permission } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import {
  YandexBooksEntriesQueryDto,
  YandexBooksImportDto,
  YandexBooksLinkDto,
  YandexBooksResolveDto,
  YandexBooksSyncDto,
  UpsertYandexBooksSettingsDto,
} from './dto/yandex-books.dto';
import { YandexBooksSettingsService } from './yandex-books-settings.service';
import { YandexBooksSyncService } from './yandex-books-sync.service';

@Controller('yandex-books')
@RequirePermission(Permission.YandexBooksSync)
export class YandexBooksController {
  constructor(
    private readonly settings: YandexBooksSettingsService,
    private readonly sync: YandexBooksSyncService,
  ) {}
  @Get('settings') getSettings(@CurrentUser() user: RequestUser) {
    return this.settings.getSettings(user.id);
  }
  @Patch('settings') @RequirePermission(Permission.YandexBooksSync, Permission.LibraryUpload) upsert(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpsertYandexBooksSettingsDto,
  ) {
    return this.settings.upsert(user.id, dto);
  }
  @Delete('settings') disconnect(@CurrentUser() user: RequestUser) {
    return this.settings.disconnect(user.id);
  }
  @Post('sync')
  @RequirePermission(Permission.YandexBooksSync, Permission.LibraryUpload)
  @HttpCode(HttpStatus.ACCEPTED)
  start(@CurrentUser() user: RequestUser, @Body() dto: YandexBooksSyncDto) {
    return this.sync.start(user, dto.preview ?? false);
  }
  @Post('import') @HttpCode(HttpStatus.ACCEPTED) @RequirePermission(Permission.YandexBooksSync, Permission.LibraryUpload) import(
    @CurrentUser() user: RequestUser,
    @Body() dto: YandexBooksImportDto,
  ) {
    return this.sync.importEntries(user, dto.entryIds);
  }
  @Get('entries') entries(@CurrentUser() user: RequestUser, @Query() query: YandexBooksEntriesQueryDto) {
    return this.sync.list(user.id, query.page, query.pageSize, query.state);
  }
  @Post('entries/:id/link') @RequirePermission(Permission.YandexBooksSync, Permission.LibraryUpload) link(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: YandexBooksLinkDto,
  ) {
    return this.sync.link(user, id, dto.bookId);
  }
  @Post('entries/:id/resolve') @RequirePermission(Permission.YandexBooksSync, Permission.LibraryUpload) resolve(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: YandexBooksResolveDto,
  ) {
    return this.sync.resolve(user, id, dto.policy);
  }
}
