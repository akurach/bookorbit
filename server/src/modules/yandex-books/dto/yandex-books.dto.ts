import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type {
  YandexBooksImportPayload,
  YandexBooksLinkPayload,
  YandexBooksResolvePayload,
  YandexBooksSyncPayload,
  UpsertYandexBooksSettingsPayload,
} from '@bookorbit/types';

export class UpsertYandexBooksSettingsDto implements UpsertYandexBooksSettingsPayload {
  @IsOptional() @IsString() @MaxLength(2048) apiToken?: string;
  @IsInt() @Min(1) libraryId!: number;
  @IsInt() @Min(1) libraryFolderId!: number;
  @IsOptional() @IsBoolean() autoSync?: boolean;
  @IsOptional() @IsInt() @IsIn([6, 12, 24, 168]) intervalHours?: number;
}
export class YandexBooksSyncDto implements YandexBooksSyncPayload {
  @IsOptional() @IsBoolean() preview?: boolean;
}
export class YandexBooksImportDto implements YandexBooksImportPayload {
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsInt({ each: true }) @Min(1, { each: true }) entryIds?: number[];
}
export class YandexBooksLinkDto implements YandexBooksLinkPayload {
  @IsInt() @Min(1) bookId!: number;
}
export class YandexBooksResolveDto implements YandexBooksResolvePayload {
  @IsIn(['safe', 'remote', 'local']) policy!: 'safe' | 'remote' | 'local';
}
export class YandexBooksEntriesQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 30;
  @IsOptional() @IsIn(['ready', 'imported', 'conflict', 'ignored']) state?: string;
}
