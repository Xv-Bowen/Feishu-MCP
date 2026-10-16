CREATE TABLE `feishu_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`encrypted_tokens` text NOT NULL,
	`expires_at` integer NOT NULL,
	`name` text NOT NULL,
	`open_id` text NOT NULL,
	`scope` text NOT NULL,
	`refresh_lock` text,
	`lock_expires_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feishu_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`encrypted_verifier` text NOT NULL,
	`expires_at` integer NOT NULL
);
