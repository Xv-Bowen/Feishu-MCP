CREATE TABLE `feishu_watch_events` (
	`id` text PRIMARY KEY NOT NULL,
	`watch_id` text NOT NULL,
	`user_id` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`observed_at` integer NOT NULL,
	`reported_at` integer
);
--> statement-breakpoint
CREATE INDEX `feishu_watch_events_owner` ON `feishu_watch_events` (`user_id`,`watch_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `feishu_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`encrypted_config` text NOT NULL,
	`encrypted_state` text NOT NULL,
	`updated_at` integer NOT NULL,
	`checked_at` integer,
	`lock` text,
	`lock_expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `feishu_watches_user` ON `feishu_watches` (`user_id`);