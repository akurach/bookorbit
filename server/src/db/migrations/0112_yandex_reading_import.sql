CREATE TABLE "external_book_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"provider" varchar(50) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"media_kind" varchar(20) NOT NULL,
	"source_url" varchar(2048) NOT NULL,
	"remote_status" varchar(64) NOT NULL,
	"percentage" real,
	"position_seconds" integer,
	"duration_seconds" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_applied_status_at" timestamp with time zone,
	CONSTRAINT "external_book_sources_user_book_provider_external_media_unique" UNIQUE("user_id","book_id","provider","external_id","media_kind"),
	CONSTRAINT "external_book_sources_user_provider_external_media_unique" UNIQUE("user_id","provider","external_id","media_kind"),
	CONSTRAINT "external_book_sources_media_kind_chk" CHECK ("external_book_sources"."media_kind" in ('ebook', 'audiobook', 'comic')),
	CONSTRAINT "external_book_sources_percentage_chk" CHECK ("external_book_sources"."percentage" is null or ("external_book_sources"."percentage" >= 0 and "external_book_sources"."percentage" <= 100)),
	CONSTRAINT "external_book_sources_position_seconds_chk" CHECK ("external_book_sources"."position_seconds" is null or "external_book_sources"."position_seconds" >= 0),
	CONSTRAINT "external_book_sources_duration_seconds_chk" CHECK ("external_book_sources"."duration_seconds" is null or "external_book_sources"."duration_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "yandex_books_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"media_kind" varchar(20) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"book_id" integer,
	"state" varchar(20) DEFAULT 'ready' NOT NULL,
	"status_policy" varchar(20) DEFAULT 'safe' NOT NULL,
	"conflict" varchar(500),
	"generation" uuid NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "yandex_books_entries_user_account_external_media_uidx" UNIQUE("user_id","account_id","external_id","media_kind"),
	CONSTRAINT "yandex_books_entries_state_chk" CHECK ("yandex_books_entries"."state" in ('ready', 'imported', 'conflict', 'ignored')),
	CONSTRAINT "yandex_books_entries_policy_chk" CHECK ("yandex_books_entries"."status_policy" in ('safe', 'remote', 'local')),
	CONSTRAINT "yandex_books_entries_media_chk" CHECK ("yandex_books_entries"."media_kind" in ('ebook', 'audiobook', 'comic'))
);
--> statement-breakpoint
CREATE TABLE "yandex_books_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"encrypted_token" text NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"account_login" varchar(255) NOT NULL,
	"account_name" varchar(500),
	"library_id" integer NOT NULL,
	"library_folder_id" integer NOT NULL,
	"auto_sync" boolean DEFAULT false NOT NULL,
	"interval_hours" integer DEFAULT 24 NOT NULL,
	"needs_reauth" boolean DEFAULT false NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_id" uuid,
	"completed_generation" uuid,
	"last_synced_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"last_error" varchar(500),
	"last_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "yandex_books_settings_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "yandex_books_settings_interval_chk" CHECK ("yandex_books_settings"."interval_hours" in (6, 12, 24, 168))
);
--> statement-breakpoint
CREATE TABLE "yandex_books_staging" (
	"user_id" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"media_kind" varchar(20) NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "yandex_books_staging_user_id_run_id_external_id_media_kind_pk" PRIMARY KEY("user_id","run_id","external_id","media_kind")
);
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "is_fileless" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "catalog_media_kind" varchar(20);--> statement-breakpoint
ALTER TABLE "external_book_sources" ADD CONSTRAINT "external_book_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_book_sources" ADD CONSTRAINT "external_book_sources_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yandex_books_entries" ADD CONSTRAINT "yandex_books_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yandex_books_entries" ADD CONSTRAINT "yandex_books_entries_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yandex_books_settings" ADD CONSTRAINT "yandex_books_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yandex_books_settings" ADD CONSTRAINT "yandex_books_settings_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yandex_books_settings" ADD CONSTRAINT "yandex_books_settings_folder_library_fk" FOREIGN KEY ("library_folder_id","library_id") REFERENCES "public"."library_folders"("id","library_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yandex_books_staging" ADD CONSTRAINT "yandex_books_staging_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_book_sources_user_book_idx" ON "external_book_sources" USING btree ("user_id","book_id");--> statement-breakpoint
CREATE INDEX "external_book_sources_book_idx" ON "external_book_sources" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "yandex_books_entries_user_account_state_id_idx" ON "yandex_books_entries" USING btree ("user_id","account_id","state","id");--> statement-breakpoint
CREATE INDEX "yandex_books_entries_generation_id_idx" ON "yandex_books_entries" USING btree ("user_id","generation","id");--> statement-breakpoint
CREATE INDEX "yandex_books_settings_due_idx" ON "yandex_books_settings" USING btree ("next_sync_at") WHERE "yandex_books_settings"."auto_sync" = true and "yandex_books_settings"."needs_reauth" = false;--> statement-breakpoint
CREATE INDEX "books_fileless_library_idx" ON "books" USING btree ("library_id","is_fileless") WHERE "books"."is_fileless" = true;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_catalog_media_kind_chk" CHECK ("books"."catalog_media_kind" is null or "books"."catalog_media_kind" in ('ebook', 'audiobook', 'comic'));